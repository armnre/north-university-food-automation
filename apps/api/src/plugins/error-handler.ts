import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ERROR_MESSAGES_FA } from '@food/shared';
import { AppError, isAppError, toSafeError } from '../lib/errors.js';
import type { ServiceDeps } from '../types.js';

type FastifyReplyWithSendFile = {
  sendFile?: (filename: string) => unknown;
};

/**
 * مدیریت یکسان خطاها.
 *
 * پاسخ همهٔ خطاها:
 * ```json
 * { "error": { "code": "...", "message": "پیام فارسی", "details": {...} } }
 * ```
 * جزئیات فنی (stack، SQL، پیام درایورها) هرگز به کلاینت نمی‌رسد؛ فقط لاگ می‌شود.
 */
export async function registerErrorHandler(
  app: FastifyInstance,
  deps: ServiceDeps,
  options: { serveSpaFallback?: boolean } = {},
): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    // خطای اعتبارسنجی Zod (fastify-type-provider-zod آن را به ZodError تبدیل می‌کند)
    if (error instanceof ZodError || (error as { name?: string }).name === 'ZodError') {
      const zodError = error as ZodError;
      const first = zodError.issues[0];
      const path = first?.path?.join('.') ?? '';
      const message = first?.message ?? ERROR_MESSAGES_FA.VALIDATION;
      void reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: path ? `${message}` : message,
          details: {
            fields: zodError.issues.slice(0, 10).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          },
        },
      });
      return;
    }

    // خطای اعتبارسنجی که Fastify از نتیجهٔ validatorCompiler می‌سازد
    const validationError = error as {
      validation?: { message?: string; keyword?: string; instancePath?: string; params?: unknown }[];
      validationContext?: string;
    };
    if (validationError.validation?.length) {
      const issue = validationError.validation[0];
      const field = String(issue?.instancePath ?? validationError.validationContext ?? '').replace(/^[./]+/, '');
      const message = String(issue?.message ?? ERROR_MESSAGES_FA.VALIDATION);
      const persian = /[\u0600-\u06FF]/.test(message) ? message : ERROR_MESSAGES_FA.VALIDATION;
      void reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: field ? `${persian} (${field})` : persian,
          details: {
            fields: validationError.validation
              .slice(0, 10)
              .map((item) => ({ path: String(item.instancePath ?? '').replace(/^[./]+/, ''), message: String(item.message ?? '') })),
          },
        },
      });
      return;
    }

    // خطاهای Fastify با وضعیت مشخص (bodyLimit، ۴۰۴، rate limit)
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyError.statusCode === 400) {
      void reply.status(400).send({ error: { code: 'VALIDATION', message: ERROR_MESSAGES_FA.VALIDATION } });
      return;
    }
    if (fastifyError.statusCode === 429) {
      void reply.status(429).send({ error: { code: 'TOO_MANY_REQUESTS', message: ERROR_MESSAGES_FA.TOO_MANY_REQUESTS } });
      return;
    }
    if (fastifyError.code === 'FST_REQ_FILE_TOO_LARGE' || fastifyError.statusCode === 413) {
      void reply.status(413).send({ error: { code: 'VALIDATION', message: 'حجم فایل ارسالی بیش از حد مجاز است.' } });
      return;
    }
    if (fastifyError.statusCode === 404) {
      void reply.status(404).send({ error: { code: 'NOT_FOUND', message: ERROR_MESSAGES_FA.NOT_FOUND } });
      return;
    }

    const safe = isAppError(error) ? error : toSafeError(error);

    if (safe.status >= 500) {
      request.log.error({ err: error, requestId: request.id, path: request.url }, 'خطای داخلی');
    } else if (deps.env.NODE_ENV === 'development' || deps.env.LOG_LEVEL === 'debug') {
      request.log.debug({ code: safe.code, status: safe.status, path: request.url }, 'خطای دامنه‌ای');
    }

    void reply.status(safe.status).send({
      error: {
        code: safe.code,
        message: safe.message || ERROR_MESSAGES_FA.INTERNAL,
        ...(safe.details ? { details: safe.details } : {}),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (
      options.serveSpaFallback &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.url.startsWith('/api') &&
      !request.url.startsWith('/uploads')
    ) {
      void reply.header('Cache-Control', 'no-cache');
      const replyWithSendFile = reply as FastifyReplyWithSendFile;
      if (typeof replyWithSendFile.sendFile === 'function') {
        return replyWithSendFile.sendFile('index.html');
      }
    }
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: ERROR_MESSAGES_FA.NOT_FOUND } });
  });

  // خطای غیرمنتظره در لایهٔ پایین‌تر (مثلاً در hookها)
  app.addHook('onError', async (request, _reply, error) => {
    if (!(error instanceof AppError)) {
      request.log.error({ err: error, requestId: request.id }, 'خطای ثبت‌شده در hook');
    }
  });
}
