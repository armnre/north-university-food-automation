import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { students } from '../../src/db/schema.js';
import { Client, testApp } from '../helpers/app.js';
import { makeEmployee, makeStaff, makeStudent, STAFF_PASSWORD } from '../helpers/factory.js';

let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

describe('student login', () => {
  it('logs in with student number + national id (Persian digits), sets HttpOnly cookie, me works', async () => {
    const { sn, nid } = await makeStudent(t.db);
    const c = new Client(t.app);
    const fa = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
    const r = await c.req('POST', '/api/v1/auth/student/login', { studentNumber: fa(sn), nationalId: fa(nid) });
    expect(r.status).toBe(200);
    const me = await c.req('GET', '/api/v1/auth/me');
    expect(me.body.kind).toBe('student');
    expect(me.body.student.nationalIdMasked).toBe(`******${nid.slice(-4)}`);
    expect(JSON.stringify(me.body)).not.toContain(nid);
  });

  it('existing and non-existing accounts get the identical response', async () => {
    const { sn } = await makeStudent(t.db);
    const a = await new Client(t.app, '10.1.0.1').req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: '0499370899' });
    const b = await new Client(t.app, '10.1.0.2').req('POST', '/api/v1/auth/student/login', { studentNumber: '99999999', nationalId: '0499370899' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('requires captcha from 3rd attempt and locks (identifier+IP) after 5 failures, without locking other IPs', async () => {
    const { sn, nid } = await makeStudent(t.db);
    const c = new Client(t.app, '10.2.0.1');
    const bad = () => c.req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: '0499370899' });
    expect((await bad()).status).toBe(401);
    const second = await bad();
    expect(second.body.error.details?.captcha?.captchaId).toBeTruthy();
    expect((await bad()).status).toBe(428); // no captcha answer
    // solve captchas for the next failures by reading the answer from DB is impossible (hashed) → brute-force small space
    const solve = async () => {
      const cap = (await c.req('GET', '/api/v1/auth/captcha')).body;
      const text = (cap.svg as string).match(/>([۰-۹])</g)!.map((m) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(m[1]!));
      return { captchaId: cap.captchaId, captchaAnswer: String(text[0]! + text[1]!) };
    };
    for (let i = 0; i < 3; i++) await c.req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: '0499370899', ...(await solve()) });
    const locked = await c.req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: nid, ...(await solve()) });
    expect(locked.status).toBe(429);
    // the real owner on another IP is not locked out
    const other = await new Client(t.app, '10.2.0.99').req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: nid });
    expect(other.status).toBe(200);
  });

  it('non-Active student cannot log in and status change revokes existing sessions', async () => {
    const { sn, nid, student } = await makeStudent(t.db);
    const c = new Client(t.app, '10.3.0.1');
    expect((await c.req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: nid })).status).toBe(200);
    await t.db.update(students).set({ status: 'Withdrawn' }).where(eq(students.id, student.id));
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await new Client(t.app, '10.3.0.2').req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: nid })).status).toBe(401);
  });
});

describe('staff/employee login, CSRF and sessions', () => {
  it('forces password change at first login, then revokes other sessions on change', async () => {
    const u = await makeStaff(t.db, 'Finance', { mustChangePassword: true });
    const a = new Client(t.app, '10.4.0.1');
    const b = new Client(t.app, '10.4.0.2');
    const r = await a.req('POST', '/api/v1/auth/staff/login', { username: u.username, password: STAFF_PASSWORD });
    expect(r.body.mustChangePassword).toBe(true);
    await b.req('POST', '/api/v1/auth/staff/login', { username: u.username, password: STAFF_PASSWORD });
    expect((await a.req('GET', '/api/v1/auth/sessions')).status).toBe(403);
    expect((await a.req('POST', '/api/v1/auth/change-password', { currentPassword: STAFF_PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await a.req('POST', '/api/v1/auth/change-password', { currentPassword: STAFF_PASSWORD, newPassword: 'New-Strong-Pass-9' })).status).toBe(200);
    expect((await a.req('GET', '/api/v1/auth/sessions')).status).toBe(200);
    expect((await b.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects state-changing requests without CSRF token or from foreign origin', async () => {
    const r1 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { username: 'x', password: 'y' } });
    expect(r1.statusCode).toBe(403);
    const c = new Client(t.app);
    const r2 = await c.req('POST', '/api/v1/auth/staff/login', { username: 'x', password: 'y' }, { origin: 'https://evil.example' });
    expect(r2.status).toBe(403);
  });

  it('employee logs in, deactivation revokes access; logout-all revokes every session', async () => {
    const e = await makeEmployee(t.db);
    const c1 = new Client(t.app, '10.5.0.1');
    const c2 = new Client(t.app, '10.5.0.2');
    await c1.req('POST', '/api/v1/auth/employee/login', { username: e.username, password: STAFF_PASSWORD });
    await c2.req('POST', '/api/v1/auth/employee/login', { username: e.username, password: STAFF_PASSWORD });
    expect((await c1.req('GET', '/api/v1/auth/me')).body.kind).toBe('employee');
    expect((await c1.req('POST', '/api/v1/auth/logout-all')).body.revoked).toBe(2);
    expect((await c2.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('setup-admin works once with the setup code only', async () => {
    const c = new Client(t.app, '10.6.0.1');
    const status = await c.req('GET', '/api/v1/auth/setup-status');
    if (status.body.needsSetup) {
      expect(
        (await c.req('POST', '/api/v1/auth/setup-admin', { setupCode: 'wrong', username: 'root1', fullName: 'مدیر', password: 'Very-Strong-123' })).status,
      ).toBe(403);
      expect(
        (
          await c.req('POST', '/api/v1/auth/setup-admin', {
            setupCode: 'setup-code-0123456789',
            username: 'root1',
            fullName: 'مدیر',
            password: 'Very-Strong-123',
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await c.req('POST', '/api/v1/auth/setup-admin', {
          setupCode: 'setup-code-0123456789',
          username: 'root2',
          fullName: 'مدیر',
          password: 'Very-Strong-123',
        })
      ).status,
    ).toBe(409);
  });

  it('sets security headers and health/ready', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['strict-transport-security']).toBeTruthy();
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['permissions-policy']).toContain('camera=(self)');
    expect((await t.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
  });
});
