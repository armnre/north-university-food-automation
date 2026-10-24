import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isValidNationalId, normalizeDigits, normalizeNationalId, ROLE_PERMISSIONS } from '@food/shared';
import type { Db } from '../db/client.js';
import { accounts, employees, notifications, staffUsers, students } from '../db/schema.js';
import type { Env } from '../env.js';
import { clearSessionCookie, issueCsrf, requirePrincipal, setSessionCookie } from '../lib/auth.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { fail } from '../lib/errors.js';
import { getClientIp } from '../lib/ip.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../lib/password.js';
import { audit } from '../services/audit.js';
import { createSession, listSessions, revokeAllForSubject, revokeSession, type SubjectType } from '../services/sessions.js';
import { createCaptcha, identifierHash, recordAttempt, throttleState, verifyCaptcha } from '../services/throttle.js';

const GENERIC = 'اطلاعات ورود صحیح نیست.';
const captchaFields = { captchaId: z.string().optional(), captchaAnswer: z.string().max(10).optional() };

export const nationalIdHash = (pepper: string, nid: string) => hmac(pepper, `nid:${normalizeNationalId(nid)}`);

export function authRoutes(app: FastifyInstance, db: Db, env: Env) {
  const secure = env.NODE_ENV !== 'test' || env.PUBLIC_BASE_URL.startsWith('https');
  const ipOf = (req: Parameters<typeof getClientIp>[0]) => getClientIp(req, env.TRUSTED_PROXY_HOPS);

  /** Shared guard: lock → captcha → verify credential → record. */
  async function guarded(kind: string, identifier: string, ip: string, body: { captchaId?: string; captchaAnswer?: string }, check: () => Promise<boolean>) {
    const ih = identifierHash(env.NATIONAL_ID_PEPPER, kind, identifier);
    const st = await throttleState(db, ih, ip);
    if (st.locked) fail('TOO_MANY_REQUESTS', 'به دلیل تلاش‌های ناموفق متعدد، ورود تا ۱۵ دقیقه ممکن نیست.');
    if (st.captchaRequired && !(await verifyCaptcha(db, body.captchaId, body.captchaAnswer))) {
      await check(); // keep timing uniform
      fail('CAPTCHA_REQUIRED', 'لطفاً کد امنیتی را وارد کنید.', { captcha: await createCaptcha(db) });
    }
    const ok = await check();
    await recordAttempt(db, ih, ip, ok);
    if (!ok) {
      const after = await throttleState(db, ih, ip);
      fail('UNAUTHORIZED', GENERIC, after.captchaRequired ? { captcha: await createCaptcha(db) } : undefined);
    }
  }

  async function startSession(reply: Parameters<typeof setSessionCookie>[0], type: SubjectType, id: string, ip: string, ua?: string) {
    const { token } = await createSession(db, type, id, ip, ua);
    setSessionCookie(reply, token, secure);
    issueCsrf(reply, secure);
  }

  app.get('/api/v1/auth/csrf', { config: { access: 'public' } }, async (_req, reply) => ({ csrfToken: issueCsrf(reply, secure) }));
  app.get('/api/v1/auth/captcha', { config: { access: 'public' } }, async () => createCaptcha(db));

  app.get('/api/v1/auth/setup-status', { config: { access: 'public' } }, async () => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(staffUsers)
      .where(eq(staffUsers.role, 'SuperAdmin'));
    return { needsSetup: (r?.n ?? 0) === 0 };
  });

  app.post('/api/v1/auth/setup-admin', { config: { access: 'public' } }, async (req) => {
    const b = z
      .object({
        setupCode: z.string().min(1).max(200),
        username: z.string().trim().min(3).max(50),
        fullName: z.string().trim().min(2).max(100),
        password: z.string(),
      })
      .parse(req.body);
    if (!env.SETUP_CODE || !safeEqual(b.setupCode, env.SETUP_CODE)) fail('FORBIDDEN', 'کد راه‌اندازی نامعتبر است.');
    const pe = passwordPolicyError(b.password);
    if (pe) fail('BAD_REQUEST', pe);
    const hash = await hashPassword(b.password);
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('setup-admin'))`);
      const [r] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(staffUsers)
        .where(eq(staffUsers.role, 'SuperAdmin'));
      if ((r?.n ?? 0) > 0) fail('CONFLICT', 'مدیر ارشد قبلاً ایجاد شده است.');
      const [u] = await tx
        .insert(staffUsers)
        .values({ username: b.username, fullName: b.fullName, role: 'SuperAdmin', passwordHash: hash, mustChangePassword: false })
        .returning({ id: staffUsers.id });
      await audit(tx, { actor: 'setup', action: 'staff.setup-admin', entityType: 'StaffUser', entityId: u!.id, ip: ipOf(req), requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/v1/auth/student/login', { config: { access: 'public' } }, async (req, reply) => {
    const b = z.object({ studentNumber: z.string().max(30), nationalId: z.string().max(30), ...captchaFields }).parse(req.body);
    const sn = normalizeDigits(b.studentNumber);
    const nid = normalizeNationalId(b.nationalId);
    const ip = ipOf(req);
    let found: typeof students.$inferSelect | undefined;
    await guarded('student', sn, ip, b, async () => {
      [found] = await db.select().from(students).where(eq(students.studentNumber, sn)).limit(1);
      const candidate = nationalIdHash(env.NATIONAL_ID_PEPPER, nid);
      const match = safeEqual(found?.nationalIdHash ?? '0'.repeat(64), candidate);
      return !!found && match && isValidNationalId(nid) && found.status === 'Active' && !found.deletedAt;
    });
    const s = found!;
    const [acct] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.studentId, s.id));
    const accountId =
      acct?.id ?? (await db.insert(accounts).values({ kind: 'Customer', studentId: s.id }).onConflictDoNothing().returning({ id: accounts.id }))[0]?.id;
    const ua = req.headers['user-agent'];
    const prev = s.lastLoginAt;
    await db.update(students).set({ lastLoginAt: new Date() }).where(eq(students.id, s.id));
    if (accountId) {
      const known = await db.execute(
        sql`SELECT 1 FROM sessions WHERE subject_type='student' AND subject_id=${s.id} AND user_agent=${ua?.slice(0, 300) ?? ''} LIMIT 1`,
      );
      if (prev && known.rows.length === 0) {
        await db
          .insert(notifications)
          .values({
            accountId,
            title: 'ورود از دستگاه جدید',
            body: 'ورود به حساب شما از یک دستگاه یا مرورگر جدید انجام شد. اگر شما نبودید، به امور دانشجویی اطلاع دهید.',
            kind: 'security',
          });
      }
    }
    await startSession(reply, 'student', s.id, ip, ua);
    await audit(db, { actor: `student:${s.id}`, action: 'auth.login', entityType: 'Student', entityId: s.id, ip, requestId: req.id });
    return { ok: true, kind: 'student' as const };
  });

  for (const kind of ['staff', 'employee'] as const) {
    app.post(`/api/v1/auth/${kind}/login`, { config: { access: 'public' } }, async (req, reply) => {
      const b = z.object({ username: z.string().trim().max(50), password: z.string().max(128), ...captchaFields }).parse(req.body);
      const ip = ipOf(req);
      const uname = b.username.toLowerCase();
      const table = kind === 'staff' ? staffUsers : employees;
      let u: { id: string; passwordHash: string; active: boolean; mustChangePassword: boolean } | undefined;
      await guarded(kind, uname, ip, b, async () => {
        [u] = await db
          .select({ id: table.id, passwordHash: table.passwordHash, active: table.active, mustChangePassword: table.mustChangePassword })
          .from(table)
          .where(sql`lower(${table.username}) = ${uname}`)
          .limit(1);
        const ok = await verifyPassword(u?.passwordHash, b.password);
        return ok && !!u?.active;
      });
      await db.update(table).set({ lastLoginAt: new Date() }).where(eq(table.id, u!.id));
      await startSession(reply, kind, u!.id, ip, req.headers['user-agent']);
      await audit(db, { actor: `${kind}:${u!.id}`, action: 'auth.login', entityType: kind, entityId: u!.id, ip, requestId: req.id });
      return { ok: true, kind, mustChangePassword: u!.mustChangePassword };
    });
  }

  app.get('/api/v1/auth/me', { config: { access: 'authenticated', allowPasswordChangePending: true } }, async (req) => {
    const p = requirePrincipal(req);
    if (p.subjectType === 'student') {
      const [s] = await db.select().from(students).where(eq(students.id, p.id));
      return {
        kind: 'student' as const,
        student: {
          id: s!.id,
          studentNumber: s!.studentNumber,
          fullName: `${s!.firstName} ${s!.lastName}`,
          faculty: s!.faculty ?? '',
          major: s!.major ?? '',
          degree: s!.degree ?? '',
          entryYear: s!.entryYear,
          nationalIdMasked: `******${s!.nationalIdLast4}`,
          lastLoginAt: s!.lastLoginAt?.toISOString() ?? null,
        },
      };
    }
    if (p.subjectType === 'employee') {
      const [e] = await db.select().from(employees).where(eq(employees.id, p.id));
      return {
        kind: 'employee' as const,
        employee: {
          id: e!.id,
          username: e!.username,
          fullName: `${e!.firstName} ${e!.lastName}`,
          employeeKind: e!.kind,
          mustChangePassword: e!.mustChangePassword,
          lastLoginAt: e!.lastLoginAt?.toISOString() ?? null,
        },
      };
    }
    const [u] = await db.select().from(staffUsers).where(eq(staffUsers.id, p.id));
    return {
      kind: 'staff' as const,
      staff: {
        id: u!.id,
        username: u!.username,
        fullName: u!.fullName,
        role: u!.role,
        perms: [...ROLE_PERMISSIONS[u!.role]],
        cafeteriaId: u!.cafeteriaId,
        mustChangePassword: u!.mustChangePassword,
      },
    };
  });

  app.post('/api/v1/auth/logout', { config: { access: 'authenticated', allowPasswordChangePending: true } }, async (req, reply) => {
    const p = requirePrincipal(req);
    await revokeSession(db, p.sessionId);
    clearSessionCookie(reply, secure);
    return { ok: true };
  });

  app.post('/api/v1/auth/logout-all', { config: { access: 'authenticated', allowPasswordChangePending: true } }, async (req, reply) => {
    const p = requirePrincipal(req);
    const n = await revokeAllForSubject(db, p.subjectType, p.id);
    clearSessionCookie(reply, secure);
    await audit(db, { actor: p.actor, action: 'auth.logout-all', ip: ipOf(req), requestId: req.id, data: { revoked: n } });
    return { ok: true, revoked: n };
  });

  app.get('/api/v1/auth/sessions', { config: { access: 'authenticated' } }, async (req) => {
    const p = requirePrincipal(req);
    const rows = await listSessions(db, p.subjectType, p.id);
    return { sessions: rows.map((r) => ({ ...r, current: r.id === p.sessionId })) };
  });

  app.delete('/api/v1/auth/sessions/:id', { config: { access: 'authenticated' } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.execute(
      sql`UPDATE sessions SET revoked_at = now() WHERE id = ${id} AND subject_type = ${p.subjectType} AND subject_id = ${p.id} AND revoked_at IS NULL RETURNING id`,
    );
    if (r.rows.length === 0) fail('NOT_FOUND', 'نشست پیدا نشد.');
    return { ok: true };
  });

  app.post('/api/v1/auth/change-password', { config: { access: 'authenticated', allowPasswordChangePending: true } }, async (req) => {
    const p = requirePrincipal(req);
    if (p.subjectType === 'student') fail('BAD_REQUEST', 'ورود دانشجو بدون رمز است.');
    const b = z.object({ currentPassword: z.string().max(128), newPassword: z.string() }).parse(req.body);
    const pe = passwordPolicyError(b.newPassword);
    if (pe) fail('BAD_REQUEST', pe);
    if (b.newPassword === b.currentPassword) fail('BAD_REQUEST', 'رمز جدید باید با رمز فعلی متفاوت باشد.');
    const table = p.subjectType === 'staff' ? staffUsers : employees;
    const [u] = await db.select({ hash: table.passwordHash }).from(table).where(eq(table.id, p.id));
    if (!(await verifyPassword(u?.hash, b.currentPassword))) fail('BAD_REQUEST', 'رمز فعلی صحیح نیست.');
    await db
      .update(table)
      .set({ passwordHash: await hashPassword(b.newPassword), mustChangePassword: false, updatedAt: new Date() })
      .where(and(eq(table.id, p.id)));
    await revokeAllForSubject(db, p.subjectType, p.id, p.sessionId); // keep only the current session
    await audit(db, { actor: p.actor, action: 'auth.change-password', ip: ipOf(req), requestId: req.id });
    return { ok: true };
  });
}
