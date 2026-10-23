import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ERROR_MESSAGES_FA, type Permission } from '@food/shared';
import { AppError } from '../lib/errors.js';
import { getClientIp } from '../lib/request-context.js';
import { resolveSessionCookieName } from '../lib/cookies.js';
import { resolveAuthContext } from '../services/auth.service.js';
import type { AuthContext, ServiceDeps } from '../types.js';

declare module 'fastify' {
  interface FastifyInstance {
    deps: ServiceDeps;
    /** پیش‌پردازندهٔ اجباری احراز هویت. */
    authenticate: (request: FastifyRequest) => Promise<void>;
    /** احراز هویت اختیاری (برای endpointهایی که رفتارشان به ورود بستگی دارد). */
    optionalAuth: (request: FastifyRequest) => Promise<void>;
    /** فقط مشتریان سلف (دانشجو یا کارمند دانشگاه). */
    requireCustomer: (request: FastifyRequest) => Promise<void>;
    /** فقط کارکنان سامانه. */
    requireStaff: (request: FastifyRequest) => Promise<void>;
    /** محافظ مجوز — پیش‌فرض: رد. */
    requirePermission: (permission: Permission | Permission[], options?: { anyOf?: boolean }) => (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    auth: AuthContext | null;
    clientIp: string;
    /** آیا یک نگهبان صریح احراز هویت/مجوز روی این درخواست اجرا شده است؟ */
    authzChecked: boolean;
  }
}

/** مسیرهایی که کاربرِ در حال «تغییر رمز اجباری» هم می‌تواند صدا بزند. */
const MUST_CHANGE_PASSWORD_ALLOWED = new Set([
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/logout-all',
  '/api/v1/auth/me',
  '/api/v1/auth/sessions',
  '/api/v1/auth/setup-status',
]);

/**
 * فهرست صریح و منجمد مسیرهای عمومی مجاز زیر `/api/v1/*`.
 * هر مسیر `/api/v1/*` خارج از این فهرست که بدون نگهبان مجوز (`authenticate` / `requireCustomer` /
 * `requireStaff` / `requirePermission`) ثبت شود، به‌صورت **Fail-Closed** با خطای `403` مسدود می‌شود.
 */
export const PUBLIC_API_V1_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/auth/setup-status',
  'POST /api/v1/auth/setup-admin',
  'GET /api/v1/auth/captcha',
  'POST /api/v1/auth/student/login',
  'POST /api/v1/auth/staff/login',
  'POST /api/v1/auth/employee/login',
  'POST /api/v1/auth/logout',
  'GET /api/v1/payments/zarinpal/callback',
  'GET /api/v1/payments/sandbox/redirect',
  'GET /api/v1/payments/status',
]);

export function normalizeRouteKey(method: string, routeUrl: string): string {
  const cleanPath = routeUrl.split('?')[0]?.replace(/\/+$/, '') || '/';
  return `${method.toUpperCase()} ${cleanPath}`;
}

/** توکن نشست از کوکی HttpOnly (sessionStorage و هدر Authorization حذف شده‌اند). */
export function readSessionToken(request: FastifyRequest, deps: ServiceDeps): string {
  const name = resolveSessionCookieName(deps.env);
  return request.cookies?.[name] ?? '';
}

export async function registerAuth(app: FastifyInstance, deps: ServiceDeps): Promise<void> {
  app.decorateRequest('auth', null);
  app.decorateRequest('clientIp', '');
  app.decorateRequest('authzChecked', false);

  app.addHook('onRequest', async (request) => {
    request.clientIp = getClientIp(request, deps.env.TRUSTED_PROXY_HOPS);
  });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = readSessionToken(request, deps);
    if (!token) throw new AppError('UNAUTHORIZED', ERROR_MESSAGES_FA.UNAUTHORIZED);
    const auth = await resolveAuthContext(deps, token, { touch: true });
    if (!auth) throw new AppError('SESSION_EXPIRED', ERROR_MESSAGES_FA.SESSION_EXPIRED);
    request.auth = auth;
    request.authzChecked = true;
  });

  app.decorate('optionalAuth', async (request: FastifyRequest) => {
    const token = readSessionToken(request, deps);
    if (!token) return;
    request.auth = await resolveAuthContext(deps, token);
  });

  app.decorate('requireCustomer', async (request: FastifyRequest) => {
    await app.authenticate(request);
    if (!request.auth || request.auth.kind === 'staff') {
      throw new AppError('FORBIDDEN', 'این بخش مخصوص دانشجویان و کارمندان دانشگاه است.');
    }
    request.authzChecked = true;
  });

  app.decorate('requireStaff', async (request: FastifyRequest) => {
    await app.authenticate(request);
    if (!request.auth || request.auth.kind !== 'staff') {
      throw new AppError('FORBIDDEN', 'این بخش مخصوص کارکنان سامانه است.');
    }
    const path = request.url.split('?')[0] ?? '';
    if (request.auth.mustChangePassword && !MUST_CHANGE_PASSWORD_ALLOWED.has(path)) {
      throw new AppError('FORBIDDEN', 'برای ادامه باید رمز عبور موقت را تغییر دهید.', { mustChangePassword: true });
    }
    request.authzChecked = true;
  });

  app.decorate(
    'requirePermission',
    (permission: Permission | Permission[], options?: { anyOf?: boolean }) => async (request: FastifyRequest) => {
      await app.requireStaff(request);
      const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
      const required = Array.isArray(permission) ? permission : [permission];
      const anyOf = options?.anyOf ?? true;
      const allowed = anyOf ? required.some((p) => auth.permissions.includes(p)) : required.every((p) => auth.permissions.includes(p));
      if (!allowed) {
        request.log.warn({ role: auth.role, required, path: request.url }, 'دسترسی رد شد');
        throw new AppError('FORBIDDEN', ERROR_MESSAGES_FA.FORBIDDEN);
      }
      request.authzChecked = true;
    },
  );

  // نگهبان سراسری Fail-Closed: هر مسیر ثبت‌شده زیر `/api/v1/` که نه عمومی مجاز باشد و نه نگهبان مجوز اجرا کرده باشد، با ۴۰۳ رد می‌شود.
  app.addHook('preHandler', async (request) => {
    const registeredPattern = request.routeOptions?.url;
    if (!registeredPattern) return;
    const cleanRoute = registeredPattern.replace(/\/+$/, '') || '/';
    if (!cleanRoute.startsWith('/api/v1/')) return;
    const key = normalizeRouteKey(request.method, cleanRoute);
    if (PUBLIC_API_V1_ROUTES.has(key)) return;
    if (!request.authzChecked) {
      request.log.error(
        { method: request.method, route: cleanRoute, url: request.url },
        'مسیر فاقد مجوز صریح توسط نگهبان Fail-Closed مسدود شد',
      );
      throw new AppError('FORBIDDEN', ERROR_MESSAGES_FA.FORBIDDEN);
    }
  });
}
