import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawRequestDefaultExpression,
  type RawReplyDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { createDb, createPool, type Db } from './db/client.js';
import { getEnv, type AppEnv } from './config/env.js';
import { createLogger, createSilentLogger } from './lib/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerSecurity } from './plugins/security.js';
import { registerAuth } from './plugins/auth.js';
import { authRoutes } from './routes/auth.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { catalogRoutes } from './routes/catalog.routes.js';
import { deliveryRoutes } from './routes/delivery.routes.js';
import { employeeRoutes } from './routes/employee.routes.js';
import { financeRoutes } from './routes/finance.routes.js';
import { importRoutes } from './routes/import.routes.js';
import { meRoutes } from './routes/me.routes.js';
import { notificationRoutes } from './routes/notification.routes.js';
import { offeringRoutes } from './routes/offering.routes.js';
import { paymentRoutes } from './routes/payment.routes.js';
import { reportRoutes } from './routes/report.routes.js';
import { reservationRoutes } from './routes/reservation.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { staffRoutes } from './routes/staff.routes.js';
import { registerUploadedFilesRoute, uploadRoutes } from './routes/upload.routes.js';
import type { ServiceDeps } from './types.js';

export type BuildAppOptions = {
  env?: AppEnv;
  db?: Db;
  logger?: Logger;
};

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger,
  ZodTypeProvider
> & {
  deps: ServiceDeps;
};

/**
 * ساخت نمونهٔ Fastify.
 *
 * لایه‌بندی: `routes` → `services` (قوانین کسب‌وکار + تراکنش) → `repositories` (Drizzle).
 * منطق کسب‌وکار در route یا کامپوننت فرانت‌اند قرار نمی‌گیرد.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<AppInstance> {
  const env = options.env ?? getEnv();
  const logger = options.logger ?? (env.NODE_ENV === 'test' ? createSilentLogger() : createLogger(env));

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // IP کلاینت توسط `getClientIp` با `TRUSTED_PROXY_HOPS` از انتهای زنجیرهٔ
    // X-Forwarded-For خوانده می‌شود (مقدار اول جعل‌پذیر است) ⇒ trustProxy خاموش.
    trustProxy: false,
    bodyLimit: env.BODY_LIMIT_BYTES,
    connectionTimeout: 20_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 10_000,
    disableRequestLogging: env.LOG_LEVEL !== 'debug' && env.LOG_LEVEL !== 'trace',
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    // CORS عمداً ثبت نمی‌شود: فرانت و API هم‌دامنه سرو می‌شوند.
  });

  const db = options.db ?? createDb(createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX, 'food-api'));
  const deps: ServiceDeps = { db, env, log: logger };

  app.decorate('deps', deps);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie, {});
  await app.register(multipart, {
    limits: {
      fileSize: env.BODY_LIMIT_BYTES,
      files: 1,
      fields: 10,
    },
    attachFieldsToBody: false,
  });

  await registerSecurity(app, deps);
  await registerErrorHandler(app, deps);
  await registerAuth(app, deps);

  // مستندات OpenAPI فقط در غیر production
  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'سامانه اتوماسیون تغذیه دانشگاه شمال',
          description: 'قرارداد REST همهٔ endpointها (اسکیماهای Zod همان قرارداد هستند).',
          version: '1.0.0',
        },
        servers: [{ url: env.PUBLIC_BASE_URL || `http://${env.HOST}:${env.PORT}` }],
        tags: [
          { name: 'auth', description: 'احراز هویت، نشست و کپچا' },
          { name: 'me', description: 'امور دانشجو/کارمند (منو، رزرو، کیف پول، برداشت)' },
          { name: 'admin', description: 'داشبورد، دانشجویان، ممیزی' },
          { name: 'catalog', description: 'پیمانکاران، سلف‌ها و غذاها' },
          { name: 'offerings', description: 'منو، قیمت‌گذاری و وضعیت وعده‌ها' },
          { name: 'reservations', description: 'مدیریت رزروها' },
          { name: 'delivery', description: 'تحویل غذا در سلف و حالت آفلاین' },
          { name: 'finance', description: 'دفتر کل، شارژ دستی، پرداخت و برداشت' },
          { name: 'imports', description: 'واردسازی اکسل دانشجویان' },
          { name: 'notifications', description: 'اعلان‌ها و صف پیامک' },
          { name: 'reports', description: 'گزارش‌های مدیریتی و خروجی CSV/Excel' },
          { name: 'settings', description: 'تنظیمات سامانه' },
          { name: 'staff', description: 'مدیریت کارکنان' },
          { name: 'employees', description: 'مدیریت کارمندان/هیئت‌علمی (مشتریان سلف)' },
        ],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/api/docs', uiConfig: { docExpansion: 'list' } });
  }

  // سرو امن تصاویر آپلودشدهٔ غذا از UPLOAD_DIR زیر مسیر /uploads/:fileName
  await registerUploadedFilesRoute(app, deps);

  // سرو کردن خروجی استاتیک فرانت‌اند در استقرار یکپارچه (SERVE_STATIC=true)
  if (env.SERVE_STATIC) {
    const webDist = resolve(process.cwd(), env.WEB_DIST_PATH || '../web/dist');
    if (existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, wildcard: false, prefix: '/' });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api') || request.url.startsWith('/uploads')) {
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'مورد درخواستی یافت نشد.' } });
        }
        return reply.sendFile('index.html');
      });
    } else {
      logger.warn({ webDist }, 'SERVE_STATIC فعال است اما پوشهٔ build فرانت‌اند یافت نشد');
    }
  }

  await app.register(healthRoutes(deps), { prefix: '/api' });
  await app.register(authRoutes(deps), { prefix: '/api/v1/auth' });
  await app.register(meRoutes(deps), { prefix: '/api/v1/me' });
  await app.register(adminRoutes(deps), { prefix: '/api/v1/admin' });
  await app.register(catalogRoutes(deps), { prefix: '/api/v1/catalog' });
  await app.register(uploadRoutes(deps), { prefix: '/api/v1/uploads' });
  await app.register(offeringRoutes(deps), { prefix: '/api/v1/offerings' });
  await app.register(reservationRoutes(deps), { prefix: '/api/v1/reservations' });
  await app.register(deliveryRoutes(deps), { prefix: '/api/v1/delivery' });
  await app.register(financeRoutes(deps), { prefix: '/api/v1/finance' });
  await app.register(paymentRoutes(deps), { prefix: '/api/v1/payments' });
  await app.register(importRoutes(deps), { prefix: '/api/v1/imports' });
  await app.register(notificationRoutes(deps), { prefix: '/api/v1/notifications' });
  await app.register(reportRoutes(deps), { prefix: '/api/v1/reports' });
  await app.register(settingsRoutes(deps), { prefix: '/api/v1/settings' });
  await app.register(staffRoutes(deps), { prefix: '/api/v1/staff' });
  await app.register(employeeRoutes(deps), { prefix: '/api/v1/employees' });

  // ممیزی زیر /api/v1/audit
  const { auditRoutes } = await import('./routes/audit.routes.js');
  await app.register(auditRoutes(deps), { prefix: '/api/v1/audit' });

  return app as unknown as AppInstance;
}
