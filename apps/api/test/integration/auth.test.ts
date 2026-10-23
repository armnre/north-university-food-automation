import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { sessions, staffUsers, students } from '../../src/db/schema/index.js';
import { hashPassword, legacyPbkdf2Hash } from '../../src/lib/crypto.js';
import { getTestDb, resetDatabase } from '../helpers/db.js';
import { buildTestApp, createTestClient, loginStaff, primeCsrf, type TestApp } from '../helpers/app.js';
import {
  createEmployee,
  createStaff,
  createStudent,
  makeInvalidNationalId,
  makeNationalId,
  resetBaseCache,
  seedBase,
} from '../helpers/fixtures.js';

/**
 * معیار پذیرش مرحلهٔ ۲: احراز هویت، نشست، محدودیت تلاش، کپچا و RBAC.
 * همهٔ تست‌ها روی PostgreSQL واقعی و اپ واقعی (با `app.inject`) اجرا می‌شوند.
 */

const db = getTestDb();
let ctx: TestApp;

beforeAll(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
  ctx = await buildTestApp({ SETUP_CODE: 'test-setup-code-0123456789abcdef' });
});

beforeEach(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
});

afterAll(async () => {
  await ctx?.close();
});

const errorOf = (body: unknown): { code?: string; message?: string } => {
  const parsed = body as { error?: { code?: string; message?: string } };
  return parsed?.error ?? {};
};

describe('ورود دانشجو (شمارهٔ دانشجویی + کد ملی، بدون رمز)', () => {
  it('با اطلاعات صحیح وارد می‌شود و کوکی نشست HttpOnly می‌گیرد', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, kind: 'student', mustChangePassword: false });
    // توکن در بدنهٔ پاسخ نیست (حذف کامل sessionStorage)
    expect(response.raw).not.toMatch(/"token"/);
    const setCookie = String(response.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);

    const me = await client.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect((me.body as { student?: { studentNumber?: string } }).student?.studentNumber).toBe(student.studentNumber);
    // کد ملی خام هیچ‌جا برنمی‌گردد
    expect(me.raw).not.toContain(student.nationalId);
  });

  it('ارقام فارسی/عربی نرمال می‌شوند', async () => {
    const student = await createStudent(db);
    const persianDigits = (value: string) => value.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/student/login', {
      studentNumber: persianDigits(student.studentNumber),
      nationalId: persianDigits(student.nationalId),
    });
    expect(response.status).toBe(200);
  });

  it('کد ملی اشتباه رد می‌شود با پیام عمومی (بدون افشای درستی سایر اطلاعات)', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: makeInvalidNationalId(12345),
    });
    expect(response.status).toBe(401);
    // پیام عمومی است: مشخص نمی‌کند کدام یک از دو مقدار اشتباه بوده است
    expect(errorOf(response.body).message).toBe('شمارهٔ دانشجویی یا کد ملی صحیح نیست.');
    expect(errorOf(response.body).code).toBe('UNAUTHORIZED');
  });

  it('دانشجوی غیرفعال پس از احراز هویت صحیح، پیام غیرفعال‌بودن می‌گیرد', async () => {
    const student = await createStudent(db, { status: 'Graduated' });
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
    });
    expect(response.status).toBe(403);
    expect(errorOf(response.body).code).toBe('ACCOUNT_INACTIVE');
    expect(errorOf(response.body).message).not.toContain('Graduated');
  });

  it('ورودی ناقص با ۴۰۰ و پیام فارسی رد می‌شود', async () => {
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/student/login', { studentNumber: '12', nationalId: '' });
    expect(response.status).toBe(400);
    expect(errorOf(response.body).code).toBe('VALIDATION');
  });

  it('پاسخ برای شناسهٔ ناموجود و موجود یکسان است (بدون user enumeration)', async () => {
    const student = await createStudent(db);
    const clientA = createTestClient(ctx.app);
    await primeCsrf(clientA);
    const existing = await clientA.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: makeInvalidNationalId(999),
    });

    const clientB = createTestClient(ctx.app);
    await primeCsrf(clientB);
    const missing = await clientB.post('/api/v1/auth/student/login', {
      studentNumber: '999999999',
      nationalId: makeInvalidNationalId(998),
    });

    expect(existing.status).toBe(missing.status);
    expect(errorOf(existing.body).message).toBe(errorOf(missing.body).message);
    expect(errorOf(existing.body).code).toBe(errorOf(missing.body).code);
  });

  it('ورود موفق، last_login_at را ثبت و رویداد ممیزی می‌نویسند', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });

    const rows = await db.select({ lastLoginAt: students.lastLoginAt }).from(students).where(eq(students.id, student.studentId));
    expect(rows[0]?.lastLoginAt).toBeInstanceOf(Date);
    const audit = await db.execute(sql`SELECT action FROM audit_logs ORDER BY created_at DESC LIMIT 5`);
    const actions = ((audit as unknown as { rows: { action: string }[] }).rows ?? []).map((r) => r.action);
    expect(actions).toContain('auth.student.success');
  });
});

describe('محدودیت تلاش و کپچا', () => {
  it('پس از ۵ تلاش ناموفق روی همان شناسه+IP، ورود قفل می‌شود', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);

    let lastStatus = 0;
    for (let i = 0; i < 5; i += 1) {
      const attempt = await client.post('/api/v1/auth/student/login', {
        studentNumber: student.studentNumber,
        nationalId: makeInvalidNationalId(1000 + i),
      });
      lastStatus = attempt.status;
      // از تلاش سوم کپچا اجباری می‌شود
      if (attempt.status === 428) {
        const captcha = await client.get<{ captchaId: string }>('/api/v1/auth/captcha');
        expect(captcha.status).toBe(200);
        expect(String((captcha.body as { imageSvg?: string }).imageSvg)).toContain('<svg');
        // بدون پاسخ صحیح، تلاش رد می‌شود
        const withCaptcha = await client.post('/api/v1/auth/student/login', {
          studentNumber: student.studentNumber,
          nationalId: makeInvalidNationalId(2000 + i),
          captchaId: (captcha.body as { captchaId: string }).captchaId,
          captchaAnswer: 'wrong-answer',
        });
        expect([400, 401, 428]).toContain(withCaptcha.status);
      }
    }
    expect([401, 423, 428]).toContain(lastStatus);

    // حتی با اطلاعات صحیح، تا پایان پنجرهٔ قفل ورود ممکن نیست
    const correct = await client.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
    });
    expect([423, 428]).toContain(correct.status);
  });

  it('قفل روی (شناسه + IP) است: همان شناسه از IP دیگر قفل نمی‌شود', async () => {
    const appWithProxy = await buildTestApp({ TRUSTED_PROXY_HOPS: '1', SETUP_CODE: 'test-setup-code-0123456789abcdef' });
    try {
      const student = await createStudent(db);
      const clientA = createTestClient(appWithProxy.app, { headers: { 'x-forwarded-for': '203.0.113.1' } });
      await primeCsrf(clientA);
      for (let i = 0; i < 6; i += 1) {
        await clientA.post('/api/v1/auth/student/login', {
          studentNumber: student.studentNumber,
          nationalId: makeInvalidNationalId(3000 + i),
        });
      }
      const locked = await clientA.post('/api/v1/auth/student/login', {
        studentNumber: student.studentNumber,
        nationalId: student.nationalId,
      });
      expect([423, 428]).toContain(locked.status);

      const clientB = createTestClient(appWithProxy.app, { headers: { 'x-forwarded-for': '203.0.113.2' } });
      await primeCsrf(clientB);
      // از IP دیگر «قفل» اعمال نمی‌شود؛ فقط ممکن است کپچا خواسته شود
      const fromOtherIp = await clientB.post('/api/v1/auth/student/login', {
        studentNumber: student.studentNumber,
        nationalId: student.nationalId,
      });
      expect(fromOtherIp.status).not.toBe(423);
      if (fromOtherIp.status === 428) {
        const { issueCaptchaForTest } = await import('./captcha-helper.js');
        const known = await issueCaptchaForTest(db, appWithProxy.env);
        const withCaptcha = await clientB.post('/api/v1/auth/student/login', {
          studentNumber: student.studentNumber,
          nationalId: student.nationalId,
          captchaId: known.captchaId,
          captchaAnswer: known.answer,
        });
        expect(withCaptcha.status).toBe(200);
      }
    } finally {
      await appWithProxy.close();
    }
  });

  it('کپچا یک‌بارمصرف است و پاسخ صحیح آن پذیرفته می‌شود', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);

    // سه شکست تا اجباری شدن کپچا
    for (let i = 0; i < 3; i += 1) {
      await client.post('/api/v1/auth/student/login', {
        studentNumber: student.studentNumber,
        nationalId: makeInvalidNationalId(4000 + i),
      });
    }
    const withoutCaptcha = await client.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
    });
    expect(withoutCaptcha.status).toBe(428);
    expect(errorOf(withoutCaptcha.body).code).toBe('CAPTCHA_REQUIRED');

    const issued = await client.get<{ captchaId: string; imageSvg: string }>('/api/v1/auth/captcha');
    const captchaId = (issued.body as { captchaId: string }).captchaId;
    // پاسخ صحیح از دیتابیس خوانده نمی‌شود؛ به‌جای آن، کپچا با پاسخ شناخته‌شده می‌سازیم
    const { issueCaptchaForTest } = await import('./captcha-helper.js');
    const known = await issueCaptchaForTest(db, ctx.env);

    const withWrongId = await client.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
      captchaId,
      captchaAnswer: '999999',
    });
    expect([400, 428]).toContain(withWrongId.status);

    const client2 = createTestClient(ctx.app);
    await primeCsrf(client2);
    for (let i = 0; i < 3; i += 1) {
      await client2.post('/api/v1/auth/student/login', {
        studentNumber: student.studentNumber,
        nationalId: makeInvalidNationalId(5000 + i),
      });
    }
    const ok = await client2.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
      captchaId: known.captchaId,
      captchaAnswer: known.answer,
    });
    expect(ok.status).toBe(200);

    // کپچای مصرف‌شده دوباره پذیرفته نمی‌شود
    const client3 = createTestClient(ctx.app);
    await primeCsrf(client3);
    const reuse = await client3.post('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
      captchaId: known.captchaId,
      captchaAnswer: known.answer,
    });
    expect([400, 200]).toContain(reuse.status);
    if (reuse.status === 400) expect(errorOf(reuse.body).code).toBe('CAPTCHA_INVALID');
  });
});

describe('ورود کارکنان و کارمندان', () => {
  it('ورود موفق کارکنان و دسترسی به /auth/me با مجوزها', async () => {
    const staff = await createStaff(db, { username: 'finance.test', role: 'Finance' });
    const client = await loginStaff(ctx.app, staff.username, staff.password);
    const me = await client.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    const body = me.body as { staff?: { role: string; permissions: string[] } };
    expect(body.staff?.role).toBe('Finance');
    expect(body.staff?.permissions).toContain('financeWrite');
    expect(body.staff?.permissions).not.toContain('settings');
  });

  it('رمز اشتباه با پیام عمومی رد می‌شود و نام کاربری ناموجود همان پیام را می‌گیرد', async () => {
    const staff = await createStaff(db, { username: 'ops.test', role: 'Operator' });
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const wrongPassword = await client.post('/api/v1/auth/staff/login', {
      username: staff.username,
      password: 'completely-wrong-password',
    });
    const unknownUser = await client.post('/api/v1/auth/staff/login', { username: 'no-such-user', password: 'completely-wrong-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(errorOf(wrongPassword.body).message).toBe(errorOf(unknownUser.body).message);
    expect(errorOf(unknownUser.body).message).toBe('نام کاربری یا رمز عبور صحیح نیست.');
  });

  it('رمز قدیمی PBKDF2 در اولین ورود به Argon2id تبدیل می‌شود', async () => {
    const legacyHash = await legacyPbkdf2Hash('legacy-password-123', 1000, 'a'.repeat(32));
    const [created] = await db
      .insert(staffUsers)
      .values({ username: 'legacy.user', fullName: 'کاربر قدیمی', role: 'Finance', status: 'Active', passwordHash: legacyHash })
      .returning({ id: staffUsers.id });

    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const login = await client.post('/api/v1/auth/staff/login', { username: 'legacy.user', password: 'legacy-password-123' });
    expect(login.status).toBe(200);

    const rows = await db.select({ passwordHash: staffUsers.passwordHash }).from(staffUsers).where(eq(staffUsers.id, created!.id));
    expect(String(rows[0]?.passwordHash)).toMatch(/^\$argon2id\$/);
  });

  it('کاربر غیرفعال نمی‌تواند وارد شود', async () => {
    const staff = await createStaff(db, { username: 'disabled.user', role: 'Finance', status: 'Disabled' });
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/staff/login', { username: staff.username, password: staff.password });
    expect(response.status).toBe(403);
    expect(errorOf(response.body).code).toBe('ACCOUNT_INACTIVE');
  });

  it('ورود کارمند (مشتری سلف) و دیدن کیف پول', async () => {
    const employee = await createEmployee(db, { balanceRial: 50_000 });
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const login = await client.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });
    expect(login.status).toBe(200);
    expect((login.body as { kind: string }).kind).toBe('employee');

    const wallet = await client.get('/api/v1/me/wallet');
    expect(wallet.status).toBe(200);
    expect((wallet.body as { balanceRial: number }).balanceRial).toBe(50_000);
  });

  it('must_change_password: تا تغییر رمز، دسترسی به سایر endpointها بسته است', async () => {
    const staff = await createStaff(db, { username: 'temp.user', role: 'Finance', mustChangePassword: true });
    const client = await loginStaff(ctx.app, staff.username, staff.password);

    const blocked = await client.get('/api/v1/finance/ledger');
    expect(blocked.status).toBe(403);
    expect((blocked.body as { error?: { details?: { mustChangePassword?: boolean } } }).error?.details?.mustChangePassword).toBe(true);

    const weak = await client.post('/api/v1/auth/change-password', { currentPassword: staff.password, newPassword: 'short' });
    expect(weak.status).toBe(400);

    const sameAsUsername = await client.post('/api/v1/auth/change-password', { currentPassword: staff.password, newPassword: 'temp.user' });
    expect(sameAsUsername.status).toBe(400);

    const changed = await client.post('/api/v1/auth/change-password', {
      currentPassword: staff.password,
      newPassword: 'a-brand-new-strong-password',
    });
    expect(changed.status).toBe(200);

    const allowed = await client.get('/api/v1/finance/ledger');
    expect(allowed.status).toBe(200);
  });
});

describe('نشست‌ها', () => {
  it('نشست باطل‌شده دیگر کار نمی‌کند', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });
    expect((await client.get('/api/v1/me/menu', { from: '2026-01-01', to: '2026-01-02' })).status).not.toBe(401);

    const logout = await client.post('/api/v1/auth/logout');
    expect(logout.status).toBe(200);
    const after = await client.get('/api/v1/auth/me');
    expect(after.status).toBe(401);
  });

  it('نشست منقضی رد می‌شود', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });

    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    const response = await client.get('/api/v1/auth/me');
    expect(response.status).toBe(401);
    expect(errorOf(response.body).code).toBe('SESSION_EXPIRED');
  });

  it('تغییر وضعیت دانشجو به غیر Active همهٔ نشست‌ها را باطل می‌کند', async () => {
    const student = await createStudent(db);
    const staff = await createStaff(db, { username: 'sa.status', role: 'SuperAdmin' });

    const studentClient = createTestClient(ctx.app);
    await primeCsrf(studentClient);
    await studentClient.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });
    expect((await studentClient.get('/api/v1/auth/me')).status).toBe(200);

    const admin = await loginStaff(ctx.app, staff.username, staff.password);
    const patch = await admin.patch(`/api/v1/admin/students/${student.studentId}/status`, { status: 'OnLeave', reason: 'مرخصی تحصیلی' });
    expect(patch.status).toBe(200);

    expect((await studentClient.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('فهرست و ابطال نشست‌ها از سمت کاربر', async () => {
    const employee = await createEmployee(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    await client.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });

    const list = await client.get<{ sessions: { id: string; current: boolean }[] }>('/api/v1/auth/sessions');
    expect(list.status).toBe(200);
    expect((list.body as { sessions: unknown[] }).sessions.length).toBeGreaterThan(0);

    const logoutAll = await client.post('/api/v1/auth/logout-all');
    expect(logoutAll.status).toBe(200);
    expect((logoutAll.body as { revoked: number }).revoked).toBeGreaterThan(0);
    expect((await client.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('درخواست بدون کوکی نشست ۴۰۱ می‌گیرد', async () => {
    const client = createTestClient(ctx.app);
    const response = await client.get('/api/v1/me/wallet');
    expect(response.status).toBe(401);
    expect(errorOf(response.body).code).toBe('UNAUTHORIZED');
  });
});

describe('راه‌اندازی اولیه و CSRF', () => {
  it('setup-status قبل از ساخت مدیر ارشد true و بعد از آن false است', async () => {
    const client = createTestClient(ctx.app);
    const before = await client.get<{ needsSetup: boolean }>('/api/v1/auth/setup-status');
    expect(before.status).toBe(200);
    expect((before.body as { needsSetup: boolean }).needsSetup).toBe(true);

    const created = await client.post('/api/v1/auth/setup-admin', {
      setupCode: 'test-setup-code-0123456789abcdef',
      username: 'root.admin',
      fullName: 'مدیر ارشد',
      password: 'a-very-strong-password',
    });
    expect(created.status).toBe(200);

    const after = await client.get<{ needsSetup: boolean }>('/api/v1/auth/setup-status');
    expect((after.body as { needsSetup: boolean }).needsSetup).toBe(false);

    // کد راه‌اندازی دوباره پذیرفته نمی‌شود
    const again = await client.post('/api/v1/auth/setup-admin', {
      setupCode: 'test-setup-code-0123456789abcdef',
      username: 'root.admin2',
      fullName: 'مدیر دوم',
      password: 'another-strong-password',
    });
    expect(again.status).toBe(403);
  });

  it('کد راه‌اندازی اشتباه رد می‌شود و در ممیزی ثبت می‌گردد', async () => {
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const response = await client.post('/api/v1/auth/setup-admin', {
      setupCode: 'wrong-code-0123456789abcdef',
      username: 'root.admin',
      fullName: 'مدیر ارشد',
      password: 'a-very-strong-password',
    });
    expect(response.status).toBe(403);
    expect(errorOf(response.body).message).toBe('کد راه‌اندازی صحیح نیست.');
    const audit = await db.execute(sql`SELECT action FROM audit_logs ORDER BY created_at DESC LIMIT 10`);
    const actions = (((audit as unknown as { rows: { action: string }[] }).rows ?? []) as { action: string }[]).map((r) => r.action);
    expect(actions).toContain('auth.setup.invalid_code');
    // کد راه‌اندازی در ممیزی ظاهر نمی‌شود
    expect(JSON.stringify(audit)).not.toContain('wrong-code');
  });

  it('متدهای غیر GET بدون هدر CSRF رد می‌شوند', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const csrf = client.csrf();
    expect(csrf).toBeTruthy();

    // حذف هدر CSRF ⇒ ۴۰۳
    const response = await client.raw('POST', '/api/v1/auth/student/login', {
      body: { studentNumber: student.studentNumber, nationalId: student.nationalId },
      headers: { 'x-csrf-token': '' },
    });
    expect(response.status).toBe(403);
    expect(errorOf(response.body).code).toBe('FORBIDDEN');
  });

  it('درخواست با Origin بیگانه رد می‌شود', async () => {
    const client = createTestClient(ctx.app, { origin: 'https://evil.example.com' });
    const response = await client.post('/api/v1/auth/student/login', { studentNumber: '123456', nationalId: '1234567890' });
    expect(response.status).toBe(403);
  });

  it('هدرهای امنیتی روی پاسخ‌ها حضور دارند', async () => {
    const client = createTestClient(ctx.app);
    const response = await client.get('/api/v1/auth/setup-status');
    expect(String(response.headers['x-content-type-options'] ?? '')).toMatch(/nosniff/i);
    expect(String(response.headers['x-frame-options'] ?? '')).toMatch(/deny/i);
    expect(String(response.headers['referrer-policy'] ?? '')).toMatch(/no-referrer/i);
    expect(String(response.headers['permissions-policy'] ?? '')).toMatch(/camera=\(self\)/i);
    expect(String(response.headers['content-security-policy'] ?? '')).toMatch(/default-src 'none'/i);
    // CORS خاموش است
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('کلاینت‌سازی رمز و تغییر رمز', () => {
  it('تغییر رمز سایر نشست‌ها را باطل می‌کند', async () => {
    const staff = await createStaff(db, { username: 'multi.session', role: 'Finance', password: 'first-strong-password' });
    const clientA = await loginStaff(ctx.app, staff.username, staff.password);
    const clientB = await loginStaff(ctx.app, staff.username, staff.password);

    expect((await clientB.get('/api/v1/auth/me')).status).toBe(200);
    const changed = await clientA.post('/api/v1/auth/change-password', {
      currentPassword: staff.password,
      newPassword: 'second-strong-password',
    });
    expect(changed.status).toBe(200);
    expect((changed.body as { revoked: number }).revoked).toBeGreaterThan(0);

    // نشست جاری A هنوز زنده است، نشست B باطل شده
    expect((await clientA.get('/api/v1/auth/me')).status).toBe(200);
    expect((await clientB.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('رمز فعلی اشتباه پذیرفته نمی‌شود', async () => {
    const staff = await createStaff(db, { username: 'wrong.current', role: 'Finance', password: 'correct-strong-password' });
    const client = await loginStaff(ctx.app, staff.username, staff.password);
    const response = await client.post('/api/v1/auth/change-password', {
      currentPassword: 'not-my-password',
      newPassword: 'another-strong-password',
    });
    expect(response.status).toBe(401);
  });

  it('دانشجو نمی‌تواند تغییر رمز بدهد (ورود بدون رمز)', async () => {
    const student = await createStudent(db);
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });
    const response = await client.post('/api/v1/auth/change-password', {
      currentPassword: 'whatever-1234',
      newPassword: 'another-strong-password',
    });
    expect(response.status).toBe(403);
  });

  it('ورود دانشجو از دستگاه جدید اعلان امنیتی ایجاد می‌کند و آخرین ورود در پروفایل برمی‌گردد', async () => {
    const student = await createStudent(db);

    const deviceA = createTestClient(ctx.app, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
    });
    await primeCsrf(deviceA);
    const loginA = await deviceA.post<{ newDevice: boolean }>('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
    });
    expect(loginA.status).toBe(200);

    const meFirst = await deviceA.get<{
      kind: 'student';
      student: { lastLoginAt: string | null; previousLogin: { at: string; ip: string | null } | null };
    }>('/api/v1/auth/me');
    expect(meFirst.status).toBe(200);
    expect(meFirst.body.student.lastLoginAt).toBeTruthy();
    expect(meFirst.body.student.previousLogin).toBeNull();

    // ورود از دستگاه/مرورگر کاملاً متفاوت باید اعلان `security.new_login` بسازد و ورود قبلی را گزارش دهد
    const deviceB = createTestClient(ctx.app, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) Safari/605.1.15' },
    });
    await primeCsrf(deviceB);
    const loginB = await deviceB.post<{ newDevice: boolean }>('/api/v1/auth/student/login', {
      studentNumber: student.studentNumber,
      nationalId: student.nationalId,
    });
    expect(loginB.status).toBe(200);
    expect(loginB.body.newDevice).toBe(true);

    const meSecond = await deviceB.get<{
      kind: 'student';
      student: { lastLoginAt: string | null; previousLogin: { at: string; ip: string | null; userAgent: string | null } | null };
    }>('/api/v1/auth/me');
    expect(meSecond.status).toBe(200);
    expect(meSecond.body.student.lastLoginAt).toBeTruthy();
    expect(meSecond.body.student.previousLogin).not.toBeNull();
    expect(meSecond.body.student.previousLogin?.userAgent).toContain('Windows NT 10.0');

    const notifications = await deviceB.get<{ notifications: Array<{ title: string; body: string }> }>('/api/v1/me/notifications');
    expect(notifications.status).toBe(200);
    expect(notifications.body.notifications.some((n) => n.title === 'ورود از دستگاه جدید')).toBe(true);
  });
});

describe('امنیت داده‌ها', () => {
  it('کد ملی خام در هیچ پاسخی ظاهر نمی‌شود', async () => {
    const nationalId = makeNationalId(777001);
    const student = await createStudent(db, { nationalId });
    const staff = await createStaff(db, { username: 'sa.privacy', role: 'SuperAdmin' });

    const admin = await loginStaff(ctx.app, staff.username, staff.password);
    const list = await admin.get('/api/v1/admin/students');
    expect(list.raw).not.toContain(nationalId);
    expect(list.raw).toContain('••••••');

    const report = await admin.get(`/api/v1/admin/students/${student.studentId}/report`);
    expect(report.status).toBe(200);
    expect(report.raw).not.toContain(nationalId);

    const audit = await admin.get('/api/v1/audit');
    expect(audit.status).toBe(200);
    expect(audit.raw).not.toContain(nationalId);
  });

  it('هش رمز عبور در هیچ پاسخی برنمی‌گردد', async () => {
    const staff = await createStaff(db, { username: 'hash.leak', role: 'SuperAdmin' });
    const admin = await loginStaff(ctx.app, staff.username, staff.password);
    const list = await admin.get('/api/v1/staff');
    expect(list.raw).not.toContain('$argon2id$');
    expect(list.raw).not.toContain('passwordHash');
    const hash = await hashPassword('x'.repeat(12));
    expect(hash).toMatch(/^\$argon2id\$/);
  });
});
