import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { foodImageUploadResponseSchema } from '@food/shared';
import { AppError } from '../lib/errors.js';
import { resolveUploadDir, SAFE_UPLOAD_FILE_RE, saveFoodImageUpload } from '../services/upload.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/** آپلود تصویر غذا توسط کارکنان مجاز (`foods`). */
export function uploadRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preValidation', app.requirePermission('foods'));

    app.post(
      '/food-image',
      {
        schema: {
          response: { 200: foodImageUploadResponseSchema },
          tags: ['catalog'],
          summary: 'آپلود امن تصویر غذا (حداکثر ۲ مگابایت، تغییر اندازه و حذف متادیتای EXIF)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '5 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        let data;
        try {
          data = await request.file({
            limits: {
              fileSize: deps.env.FOOD_IMAGE_MAX_BYTES,
              files: 1,
            },
          });
        } catch (error) {
          if (hasMultipartSizeError(error)) {
            throw new AppError('VALIDATION', 'حجم تصویر نباید بیشتر از ۲ مگابایت باشد.');
          }
          throw error;
        }

        if (!data) {
          throw new AppError('VALIDATION', 'فایلی ارسال نشد.');
        }
        if (data.fieldname !== 'file') {
          throw new AppError('VALIDATION', 'نام فیلد فایل باید `file` باشد.');
        }

        let buffer: Buffer;
        try {
          buffer = await data.toBuffer();
        } catch (error) {
          if (hasMultipartSizeError(error)) {
            throw new AppError('VALIDATION', 'حجم تصویر نباید بیشتر از ۲ مگابایت باشد.');
          }
          throw error;
        }

        return saveFoodImageUpload(deps, {
          buffer,
          declaredMimeType: data.mimetype,
          originalFileName: data.filename,
          truncated: data.file.truncated,
          actor: actorOf(auth),
          ip: request.clientIp,
        });
      },
    );
  };
}

/** سرو ایمن تصاویر آپلودشده از `/uploads/:fileName` با کش طولانی‌مدت و بدون اجرای اسکریپت. */
export async function registerUploadedFilesRoute(app: FastifyInstance, deps: ServiceDeps): Promise<void> {
  const uploadDir = resolveUploadDir(deps.env);

  app.get('/uploads/:fileName', async (request, reply) => {
    const { fileName } = request.params as { fileName: string };
    if (!SAFE_UPLOAD_FILE_RE.test(fileName)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'تصویر مورد نظر یافت نشد.' } });
    }

    const fullPath = resolve(uploadDir, fileName);
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'تصویر مورد نظر یافت نشد.' } });
    }
    if (!fileStat.isFile()) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'تصویر مورد نظر یافت نشد.' } });
    }

    const etag = `"${fileName}-${fileStat.size}"`;
    if (request.headers['if-none-match'] === etag) {
      return reply.header('ETag', etag).header('Cache-Control', 'public, max-age=2592000, immutable').status(304).send();
    }

    const contentType = fileName.endsWith('.webp') ? 'image/webp' : fileName.endsWith('.png') ? 'image/png' : 'image/jpeg';

    return reply
      .header('Content-Type', contentType)
      .header('Content-Length', fileStat.size)
      .header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=2592000, immutable')
      .header('ETag', etag)
      .send(createReadStream(fullPath));
  });
}

function hasMultipartSizeError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  return code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT';
}
