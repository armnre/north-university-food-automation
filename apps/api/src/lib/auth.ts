import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { hasPermission, type Permission, type Role, type StaffRole } from '@food/shared';
import type { Db } from '../db/client.js';
import { employees, staffUsers, students } from '../db/schema.js';
import { resolveSession, type SubjectType } from '../services/sessions.js';
import { AppError, fail } from './errors.js';
import { randomToken, safeEqual } from './crypto.js';

export const SESSION_COOKIE = '__Host-sid';
export const CSRF_COOKIE = '__Host-csrf';
export const CSRF_HEADER = 'x-csrf-token';

export type Principal = {
  sessionId: string;
  subjectType: SubjectType;
  id: string;
  role: Role;
  actor: string; // audit label, e.g. "staff:<id>" (no PII)
  cafeteriaId: string | null;
  contractorId: string | null;
  mustChangePassword: boolean;
};

/** Route access: 'public', 'authenticated' (any signed-in principal), or a specific permission. */
export type Access = 'public' | 'authenticated' | Permission;

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    allowPasswordChangePending?: boolean;
    skipCsrf?: boolean;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

async function loadPrincipal(db: Db, s: { id: string; subjectType: SubjectType; subjectId: string }): Promise<Principal | null> {
  if (s.subjectType === 'student') {
    const [u] = await db.select({ status: students.status, deletedAt: students.deletedAt }).from(students).where(eq(students.id, s.subjectId));
    if (!u || u.status !== 'Active' || u.deletedAt) return null;
    return {
      sessionId: s.id,
      subjectType: 'student',
      id: s.subjectId,
      role: 'Student',
      actor: `student:${s.subjectId}`,
      cafeteriaId: null,
      contractorId: null,
      mustChangePassword: false,
    };
  }
  if (s.subjectType === 'employee') {
    const [u] = await db.select({ active: employees.active, must: employees.mustChangePassword }).from(employees).where(eq(employees.id, s.subjectId));
    if (!u || !u.active) return null;
    return {
      sessionId: s.id,
      subjectType: 'employee',
      id: s.subjectId,
      role: 'Employee',
      actor: `employee:${s.subjectId}`,
      cafeteriaId: null,
      contractorId: null,
      mustChangePassword: u.must,
    };
  }
  const [u] = await db.select().from(staffUsers).where(eq(staffUsers.id, s.subjectId));
  if (!u || !u.active) return null;
  return {
    sessionId: s.id,
    subjectType: 'staff',
    id: u.id,
    role: u.role as StaffRole,
    actor: `staff:${u.id}`,
    cafeteriaId: u.cafeteriaId,
    contractorId: u.contractorId,
    mustChangePassword: u.mustChangePassword,
  };
}

export function registerAuth(app: FastifyInstance, db: Db, opts: { publicOrigin: string; secureCookies: boolean }) {
  app.decorateRequest('principal', null);

  // Default deny: every /api/v1 route must declare its access level at registration time.
  const registry: { method: string; url: string; access: string }[] = [];
  app.decorate('routeRegistry', registry);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1')) return;
    if (!route.config?.access) throw new Error(`route ${route.method} ${route.url} has no access declaration`);
    for (const m of [route.method].flat()) if (m !== 'HEAD') registry.push({ method: m, url: route.url, access: route.config.access });
  });

  app.addHook('onRequest', async (req, reply) => {
    const access = req.routeOptions.config?.access;
    if (!req.url.startsWith('/api/v1') || !access) return;

    // CSRF: Origin check + double-submit token for state-changing requests.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.routeOptions.config?.skipCsrf) {
      const origin = req.headers.origin;
      if (origin && origin !== opts.publicOrigin) fail('FORBIDDEN', 'درخواست از مبدأ نامعتبر رد شد.');
      const cookie = req.cookies[CSRF_COOKIE];
      const header = req.headers[CSRF_HEADER];
      if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) fail('FORBIDDEN', 'نشست امنیتی منقضی شده است. صفحه را دوباره بارگذاری کنید.');
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const s = await resolveSession(db, token);
      req.principal = s ? await loadPrincipal(db, s) : null;
      if (!req.principal) clearSessionCookie(reply, opts.secureCookies);
    }
    if (access === 'public') return;
    if (!req.principal) fail('UNAUTHORIZED', 'لطفاً دوباره وارد شوید.');
    if (req.principal.mustChangePassword && !req.routeOptions.config?.allowPasswordChangePending)
      fail('PASSWORD_CHANGE_REQUIRED', 'برای ادامه باید رمز عبور خود را تغییر دهید.');
    if (access !== 'authenticated' && !hasPermission(req.principal.role, access)) fail('FORBIDDEN', 'شما به این بخش دسترسی ندارید.');
  });
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw new AppError('UNAUTHORIZED', 'لطفاً دوباره وارد شوید.');
  return req.principal;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, secure, sameSite: 'strict', maxAge: 7 * 24 * 3600 });
}
export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'strict' });
}
/** Issues the readable CSRF cookie (double-submit). Called on GET /auth/csrf and after login. */
export function issueCsrf(reply: FastifyReply, secure: boolean) {
  const t = randomToken(24);
  reply.setCookie(CSRF_COOKIE, t, { path: '/', httpOnly: false, secure, sameSite: 'strict' });
  return t;
}
