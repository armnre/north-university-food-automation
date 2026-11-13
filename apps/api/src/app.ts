import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type pg from 'pg';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import { registerAuth } from './lib/auth.js';
import { AppError } from './lib/errors.js';
import { getClientIp } from './lib/ip.js';
import { authRoutes } from './routes/auth.js';
import { systemRoutes } from './routes/system.js';
import { meRoutes } from './routes/me.js';
import { catalogRoutes } from './routes/catalog.js';
import { offeringRoutes } from './routes/offerings.js';
import { deliveryRoutes } from './routes/delivery.js';
import { adminRoutes } from './routes/admin.js';
import { paymentRoutes } from './routes/payments.js';
import { importRoutes } from './routes/imports.js';
import multipart from '@fastify/multipart';
import { reportRoutes } from './routes/reports.js';
import { uploadRoutes } from './routes/uploads.js';
import { gatewayFromEnv, type PaymentGateway } from './services/gateway.js';

export type AppDeps = { env: Env; db: Db; pool: pg.Pool; gateway?: PaymentGateway | null };

export async function buildApp({ env, db, pool, gateway }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.NODE_ENV === 'production' ? 'info' : 'debug',
            redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'], remove: true },
          },
    genReqId: (req) =>
      typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID(),
    bodyLimit: env.BODY_LIMIT_BYTES,
    connectionTimeout: 120_000,
    requestTimeout: 120_000,
    trustProxy: false, // IPs are derived only via getClientIp()
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://trustseal.enamad.ir'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://sep.shaparak.ir', 'https://www.zarinpal.com', 'https://sandbox.zarinpal.com'],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: (req) => getClientIp(req, env.TRUSTED_PROXY_HOPS) });

  const FIELD_FA: Record<string, string> = {
    password: 'رمز عبور', currentPassword: 'رمز فعلی', newPassword: 'رمز جدید', username: 'نام کاربری', studentNumber: 'شماره دانشجویی',
    nationalCode: 'کد ملی', nationalId: 'کد ملی', mobile: 'شماره موبایل', phone: 'شماره تلفن', email: 'ایمیل', firstName: 'نام', lastName: 'نام خانوادگی',
    name: 'نام', title: 'عنوان', price: 'قیمت', amount: 'مبلغ', date: 'تاریخ', quantity: 'تعداد', captchaAnswer: 'کد امنیتی', captcha: 'کد امنیتی',
    reason: 'علت', description: 'توضیحات', capacity: 'ظرفیت', mealType: 'وعده', code: 'کد',
  };
  const zodMessage = (err: ZodError) => {
    const i = err.issues[0];
    if (!i) return 'برخی از اطلاعات واردشده معتبر نیست؛ لطفاً فیلدها را بررسی کنید.';
    const key = [...i.path].reverse().find((p) => typeof p === 'string') as string | undefined;
    const label = key ? FIELD_FA[key] : undefined;
    if (!label) return 'برخی از اطلاعات واردشده معتبر نیست؛ لطفاً فیلدها را بررسی کنید.';
    const t = i.code as string;
    const fa = /[\u0600-\u06FF]/.test(i.message);
    if (t === 'too_small') return fa ? i.message : `${label} کوتاه‌تر یا کمتر از حد مجاز است.`;
    if (t === 'too_big') return `${label} بیشتر از حد مجاز است.`;
    if (t === 'invalid_type' && /required|undefined/i.test(i.message)) return `لطفاً ${label} را وارد کنید.`;
    return fa ? i.message : `${label} معتبر نیست.`;
  };
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    if (err instanceof ZodError)
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: zodMessage(err),
          details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        },
      });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply.status(429).send({ error: { code: 'TOO_MANY_REQUESTS', message: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.' } });
    if (status === 413) return reply.status(413).send({ error: { code: 'BAD_REQUEST', message: 'حجم درخواست بیش از حد مجاز است.' } });
    if (status && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: 'درخواست نامعتبر است.' } });
    req.log.error({ err }, 'unhandled error');
    if (process.env.DEBUG_ERRORS) console.error('UNHANDLED', err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'خطای داخلی سرور. لطفاً دوباره تلاش کنید.' } });
  });

  registerAuth(app, db, { publicOrigin: new URL(env.PUBLIC_BASE_URL).origin, secureCookies: env.NODE_ENV !== 'test' });
  systemRoutes(app, pool);
  authRoutes(app, db, env);
  meRoutes(app, db);
  catalogRoutes(app, db);
  offeringRoutes(app, db);
  deliveryRoutes(app, db);
  adminRoutes(app, db);
  importRoutes(app, db, env);
  reportRoutes(app, db);
  uploadRoutes(app, db, env);
  paymentRoutes(app, db, env, gateway === undefined ? gatewayFromEnv(env) : gateway);
  return app;
}
