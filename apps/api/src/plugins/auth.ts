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

/** توکن نشست از کوکی HttpOnly (sessionStorage و هدر Authorization حذف شده‌اند). */
export function readSessionToken(request: FastifyRequest, deps: ServiceDeps): string {
  const name = resolveSessionCookieName(deps.env);
  return request.cookies?.[name] ?? '';
}

export async function registerAuth(app: FastifyInstance, deps: ServiceDeps): Promise<void> {
  app.decorateRequest('auth', null);
  app.decorateRequest('clientIp', '');

  app.addHook('onRequest', async (request) => {
    request.clientIp = getClientIp(request, deps.env.TRUSTED_PROXY_HOPS);
  });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = readSessionToken(request, deps);
    if (!token) throw new AppError('UNAUTHORIZED', ERROR_MESSAGES_FA.UNAUTHORIZED);
    const auth = await resolveAuthContext(deps, token, { touch: true });
    if (!auth) throw new AppError('SESSION_EXPIRED', ERROR_MESSAGES_FA.SESSION_EXPIRED);
    request.auth = auth;
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
    },
  );
}
