import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  captchaResponseSchema,
  changePasswordRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
  passwordLoginRequestSchema,
  revokeSessionRequestSchema,
  sessionsListResponseSchema,
  setupAdminRequestSchema,
  setupStatusResponseSchema,
  studentLoginRequestSchema,
} from '@food/shared';
import { sessionCookieOptions, resolveSessionCookieName } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';
import {
  changePassword,
  loginEmployee,
  loginStaff,
  loginStudent,
  logout,
  logoutAll,
  setupAdmin,
  setupStatus,
} from '../services/auth.service.js';
import { issueCaptcha } from '../services/captcha.service.js';
import { employeeMobile } from '../services/notification.service.js';
import { listSessions, revokeSessionById } from '../services/session.service.js';
import { readSessionToken } from '../plugins/auth.js';
import type { AuthContext, ServiceDeps } from '../types.js';

/**
 * مسیرهای احراز هویت، نشست و کپچا.
 * همه زیر `/api/v1/auth`. توکن نشست فقط در کوکی HttpOnly ارسال می‌شود.
 */

export function authRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  const routes: FastifyPluginAsyncZod = async (app) => {
    // --- راه‌اندازی اولیه -------------------------------------------------
    app.get(
      '/setup-status',
      {
        schema: { response: { 200: setupStatusResponseSchema }, summary: 'وضعیت راه‌اندازی اولیهٔ سامانه' },
      },
      async () => setupStatus(deps),
    );

    app.post(
      '/setup-admin',
      {
        schema: {
          body: setupAdminRequestSchema,
          response: { 200: setupStatusResponseSchema },
          summary: 'ساخت اولین مدیر ارشد با کد راه‌اندازی',
        },
        config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        await setupAdmin(deps, { ...request.body, ip: request.clientIp, userAgent: request.headers['user-agent'] });
        void reply.header('Cache-Control', 'no-store');
        return setupStatus(deps);
      },
    );

    // --- کپچا --------------------------------------------------------------
    app.get('/captcha', { schema: { response: { 200: captchaResponseSchema }, summary: 'دریافت کپچای یک‌بارمصرف' } }, async () => {
      const issued = await issueCaptcha(deps, 'Math');
      return {
        captchaId: issued.captchaId,
        kind: issued.kind,
        imageSvg: issued.imageSvg,
        expiresAt: issued.expiresAt.toISOString(),
        required: true,
      };
    });

    // --- ورود ---------------------------------------------------------------
    const loginRateLimit = { max: deps.env.RATE_LIMIT_LOGIN_ROUTE_MAX, timeWindow: `${deps.env.RATE_LIMIT_LOGIN_WINDOW_SECONDS} seconds` };

    app.post(
      '/student/login',
      {
        schema: {
          body: studentLoginRequestSchema,
          response: { 200: loginResponseSchema },
          summary: 'ورود دانشجو با شمارهٔ دانشجویی و کد ملی',
        },
        config: { rateLimit: loginRateLimit },
      },
      async (request, reply) => {
        const result = await loginStudent(deps, {
          studentNumber: request.body.studentNumber,
          nationalId: request.body.nationalId,
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
          captchaId: request.body.captchaId,
          captchaAnswer: request.body.captchaAnswer,
        });
        setSessionCookie(reply, deps, result.token, 'student');
        return { ok: true as const, kind: result.kind, mustChangePassword: result.mustChangePassword, newDevice: result.newDevice };
      },
    );

    app.post(
      '/staff/login',
      {
        schema: { body: passwordLoginRequestSchema, response: { 200: loginResponseSchema }, summary: 'ورود کارکنان سامانه' },
        config: { rateLimit: loginRateLimit },
      },
      async (request, reply) => {
        const result = await loginStaff(deps, {
          username: request.body.username,
          password: request.body.password,
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
          captchaId: request.body.captchaId,
          captchaAnswer: request.body.captchaAnswer,
        });
        setSessionCookie(reply, deps, result.token, 'staff');
        return { ok: true as const, kind: result.kind, mustChangePassword: result.mustChangePassword, newDevice: result.newDevice };
      },
    );

    app.post(
      '/employee/login',
      {
        schema: {
          body: passwordLoginRequestSchema,
          response: { 200: loginResponseSchema },
          summary: 'ورود کارمند/هیئت‌علمی/پیمانکار دانشگاه',
        },
        config: { rateLimit: loginRateLimit },
      },
      async (request, reply) => {
        const result = await loginEmployee(deps, {
          username: request.body.username,
          password: request.body.password,
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
          captchaId: request.body.captchaId,
          captchaAnswer: request.body.captchaAnswer,
        });
        setSessionCookie(reply, deps, result.token, 'employee');
        return { ok: true as const, kind: result.kind, mustChangePassword: result.mustChangePassword, newDevice: result.newDevice };
      },
    );

    // --- نشست جاری ----------------------------------------------------------
    app.get(
      '/me',
      {
        schema: { response: { 200: meResponseSchema }, summary: 'پروفایل کاربر جاری' },
        preValidation: (request) => app.authenticate(request),
      },
      async (request) => buildMeResponse(deps, request.auth!),
    );

    app.post('/logout', { schema: { response: { 200: logoutResponseSchema }, summary: 'خروج از نشست جاری' } }, async (request, reply) => {
      const token = readSessionToken(request, deps);
      if (token) await logout(deps, token, request.clientIp);
      clearSessionCookie(reply, deps);
      return { ok: true as const, revoked: 1 };
    });

    app.post(
      '/logout-all',
      {
        schema: { response: { 200: logoutResponseSchema }, summary: 'خروج از همهٔ نشست‌ها' },
        preValidation: (request) => app.authenticate(request),
      },
      async (request, reply) => {
        const revoked = await logoutAll(deps, request.auth!, request.clientIp);
        clearSessionCookie(reply, deps);
        return { ok: true as const, revoked };
      },
    );

    app.get(
      '/sessions',
      {
        schema: { response: { 200: sessionsListResponseSchema }, summary: 'فهرست نشست‌های فعال' },
        preValidation: (request) => app.authenticate(request),
      },
      async (request) => {
        const auth = request.auth!;
        const subjectId = auth.kind === 'student' ? auth.studentId : auth.kind === 'employee' ? auth.employeeId : auth.staffId;
        const rows = await listSessions(deps, auth.subjectType, subjectId);
        const currentToken = readSessionToken(request, deps);
        return {
          sessions: rows.map((row) => ({
            id: row.id,
            ip: row.ip,
            userAgent: row.userAgent,
            createdAt: row.createdAt.toISOString(),
            lastSeenAt: row.lastSeenAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            current: row.id === auth.sessionId && Boolean(currentToken),
          })),
        };
      },
    );

    app.delete(
      '/sessions',
      {
        schema: { body: revokeSessionRequestSchema, response: { 200: logoutResponseSchema }, summary: 'ابطال یک نشست مشخص' },
        preValidation: (request) => app.authenticate(request),
      },
      async (request) => {
        const auth = request.auth!;
        const subjectId = auth.kind === 'student' ? auth.studentId : auth.kind === 'employee' ? auth.employeeId : auth.staffId;
        const ok = await revokeSessionById(deps, request.body.sessionId, auth.subjectType, subjectId, 'user');
        if (!ok) throw new AppError('NOT_FOUND', 'نشست یافت نشد یا قبلاً باطل شده است.');
        return { ok: true as const, revoked: 1 };
      },
    );

    app.post(
      '/change-password',
      {
        schema: {
          body: changePasswordRequestSchema,
          response: { 200: logoutResponseSchema },
          summary: 'تغییر رمز عبور (کارکنان و کارمندان)',
        },
        preValidation: (request) => app.authenticate(request),
      },
      async (request) => {
        const result = await changePassword(deps, {
          auth: request.auth!,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
        });
        return { ok: true as const, revoked: result.revokedSessions };
      },
    );
  };
  return routes;
}

export function setSessionCookie(reply: FastifyReply, deps: ServiceDeps, token: string, kind: 'student' | 'employee' | 'staff'): void {
  const hours = kind === 'staff' ? deps.env.SESSION_TTL_STAFF_HOURS : deps.env.SESSION_TTL_STUDENT_HOURS;
  reply.setCookie(resolveSessionCookieName(deps.env), token, sessionCookieOptions(deps.env, hours * 3600));
}

export function clearSessionCookie(reply: FastifyReply, deps: ServiceDeps): void {
  reply.clearCookie(resolveSessionCookieName(deps.env), { path: '/' });
}

/** ساخت پاسخ `/auth/me` برای هر سه نوع کاربر (بدون افشای دادهٔ حساس). */
export async function buildMeResponse(deps: ServiceDeps, auth: AuthContext): Promise<z.infer<typeof meResponseSchema>> {
  if (auth.kind === 'student') {
    return {
      kind: 'student' as const,
      student: {
        id: auth.studentId,
        studentNumber: auth.studentNumber,
        fullName: auth.fullName,
        faculty: auth.faculty,
        major: auth.major,
        degree: auth.degree,
        entryYear: auth.entryYear,
        nationalIdMasked: `••••••${auth.nationalIdLast4 || '••••'}`,
        status: auth.status,
        balanceRial: auth.balanceRial,
        customerGroup: 'Student' as const,
      },
    };
  }
  if (auth.kind === 'employee') {
    return {
      kind: 'employee' as const,
      employee: {
        id: auth.employeeId,
        username: auth.username,
        fullName: auth.fullName,
        department: auth.department,
        mobile: await employeeMobile(deps.db, auth.employeeId),
        customerGroup: auth.customerGroup,
        status: auth.status,
        balanceRial: auth.balanceRial,
        accountId: auth.accountId,
      },
    };
  }
  return {
    kind: 'staff' as const,
    staff: {
      id: auth.staffId,
      username: auth.username,
      fullName: auth.fullName,
      role: auth.role,
      status: auth.status,
      permissions: [...auth.permissions],
      contractorId: auth.contractorId,
      cafeteriaId: auth.cafeteriaId,
      mustChangePassword: auth.mustChangePassword,
    },
  };
}
