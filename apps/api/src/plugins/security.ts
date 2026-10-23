import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomHex } from '../lib/crypto.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SAFE_METHODS,
  csrfCookieOptions,
  isSameOrigin,
  issueCsrfToken,
  verifyCsrfToken,
} from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from '../types.js';

/**
 * هدرهای امنیتی، محدودیت نرخ و CSRF.
 *
 *  - CORS خاموش است: فرانت و API هم‌دامنه (same-origin) سرو می‌شوند.
 *  - CSRF به روش double-submit: کوکی `csrf` + هدر `X-CSRF-Token` برای همهٔ
 *    متدهای غیر GET، به‌علاوهٔ بررسی `Origin`/`Referer`.
 *  - محدودیت نرخ عمومی در حافظهٔ پروسه (مسیرهای کم‌خطر)؛ محدودیت ورود و
 *    عملیات مالی/رزرو در PostgreSQL (سرویس `login-throttle` و rate limit اختصاصی).
 */

const PERMISSIONS_POLICY = ['camera=(self)', 'geolocation=()', 'microphone=()', 'payment=()', 'usb=()', 'interest-cohort=()'].join(', ');

const SPA_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
].join('; ');

export async function registerSecurity(app: FastifyInstance, deps: ServiceDeps): Promise<void> {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        objectSrc: ["'none'"],
        // صفحهٔ بازگشت از درگاه زرین‌پال یک navigation ساده است؛ نیاز به script ندارد
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    // HSTS فقط در production (nginx هم HSTS می‌گذارد؛ تکراری بودن هدر خطا می‌دهد)
    hsts: deps.env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    xPoweredBy: false,
  } as never);

  // helmet از Permissions-Policy پشتیبانی مستقیم ندارد ⇒ هدر دستی
  // همچنین برای مسیرهای استاتیک SPA (غیر از /api و /uploads) هدر CSP سازگار با اپ هم‌دامنه تنظیم می‌شود.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    if (deps.env.SERVE_STATIC && !request.url.startsWith('/api') && !request.url.startsWith('/uploads')) {
      void reply.header('Content-Security-Policy', SPA_CSP);
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: deps.env.RATE_LIMIT_DEFAULT_MAX,
    timeWindow: `${deps.env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS} seconds`,
    // حافظهٔ پروسه: برای مسیرهای کم‌خطر کافی است و وابستگی جدیدی به سرور اضافه نمی‌کند
    keyGenerator: (request) => request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || request.ip,
    errorResponseBuilder: () => ({
      error: { code: 'TOO_MANY_REQUESTS', message: 'تعداد درخواست‌ها از حد مجاز گذشت. کمی بعد دوباره تلاش کنید.' },
    }),
    allowList: (request) => request.url === '/api/health',
  });

  // محدودیت اندازهٔ بدنه و timeout
  app.addHook('onRequest', async (request) => {
    const length = Number(request.headers['content-length'] ?? 0);
    if (length > deps.env.BODY_LIMIT_BYTES) {
      throw new AppError('VALIDATION', 'حجم دادهٔ ارسالی بیش از حد مجاز است.', undefined, 413);
    }
  });

  registerCsrf(app, deps);
}

/**
 * CSRF double-submit:
 *  ۱. کوکی `csrf` در هر پاسخ که وجود ندارد صادر می‌شود (قابل خواندن توسط JS).
 *  ۲. برای متدهای غیر GET: هدر `X-CSRF-Token` باید با کوکی مطابقت داشته باشد و
 *     امضای آن با `CSRF_SECRET` معتبر باشد.
 *  ۳. `Origin`/`Referer` باید هم‌دامنه باشد.
 *
 * استثنا: callback درگاه پرداخت (زرین‌پال) که از دامنهٔ درگاه با GET می‌آید
 * و مسیرهای ورود که هنوز کوکی ندارند (برای آن‌ها کپچا/محدودیت تلاش اعمال می‌شود).
 */
const CSRF_EXEMPT_PATHS = ['/api/v1/auth/captcha', '/api/health', '/api/ready'];

export function registerCsrf(app: FastifyInstance, deps: ServiceDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const exempt = CSRF_EXEMPT_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

    if (SAFE_METHODS.has(request.method)) {
      if (!exempt) ensureCsrfCookie(request, reply, deps);
      return;
    }

    if (
      !isSameOrigin(deps.env, {
        origin: request.headers.origin as string | undefined,
        referer: request.headers.referer as string | undefined,
        host: request.headers.host as string | undefined,
      })
    ) {
      throw new AppError('FORBIDDEN', 'درخواست از مبدأ نامعتبر ارسال شده است.', undefined, 403);
    }

    // مسیرهای ورود پیش از داشتن کوکی نشست فراخوانی می‌شوند؛ همچنان CSRF لازم دارند
    // (کوکی csrf در اولین GET مثل /auth/setup-status یا /auth/captcha صادر می‌شود).
    const cookieToken = request.cookies?.[CSRF_COOKIE_NAME];
    const headerToken = request.headers[CSRF_HEADER_NAME];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !headerValue || cookieToken !== headerValue) {
      throw new AppError('FORBIDDEN', 'توکن محافظت از درخواست (CSRF) معتبر نیست. صفحه را تازه کنید و دوباره تلاش کنید.', undefined, 403);
    }
    if (!verifyCsrfToken(deps.env, cookieToken)) {
      throw new AppError('FORBIDDEN', 'توکن محافظت از درخواست (CSRF) نامعتبر است.', undefined, 403);
    }
    ensureCsrfCookie(request, reply, deps);
  });
}

function ensureCsrfCookie(request: FastifyRequest, reply: FastifyReply, deps: ServiceDeps): void {
  const existing = request.cookies?.[CSRF_COOKIE_NAME];
  if (existing && verifyCsrfToken(deps.env, existing)) return;
  reply.cookie(CSRF_COOKIE_NAME, issueCsrfToken(deps.env, randomHex(16)), csrfCookieOptions(deps.env));
}
