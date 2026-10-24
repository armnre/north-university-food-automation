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

export type AppDeps = { env: Env; db: Db; pool: pg.Pool };

export async function buildApp({ env, db, pool }: AppDeps): Promise<FastifyInstance> {
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
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://www.zarinpal.com', 'https://sandbox.zarinpal.com'],
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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    if (err instanceof ZodError)
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'اطلاعات ارسالی معتبر نیست.',
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
  return app;
}
