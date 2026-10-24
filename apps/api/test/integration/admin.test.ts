import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client, testApp } from '../helpers/app.js';
import { makeStaff, makeStudent, STAFF_PASSWORD } from '../helpers/factory.js';

let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});
const as = async (role: Parameters<typeof makeStaff>[1], ip: string) => {
  const u = await makeStaff(t.db, role);
  const c = new Client(t.app, ip);
  await c.req('POST', '/api/v1/auth/staff/login', { username: u.username, password: STAFF_PASSWORD });
  return c;
};

describe('account hierarchy', () => {
  it('StudentAffairs creates only employees; NutritionManager only Operator/Contractor; nobody creates same/higher level', async () => {
    const sa = await as('StudentAffairs', '10.30.0.1');
    const nm = await as('NutritionManager', '10.30.0.2');
    const su = await as('SuperAdmin', '10.30.0.3');
    const caf = (await t.db.execute<{ id: string }>(sql`SELECT id FROM cafeterias LIMIT 1`)).rows[0]!.id;
    const staff = (role: string, u: string) => ({ username: u, fullName: 'تست', role, active: true, cafeteriaId: caf });
    expect((await sa.req('PUT', '/api/v1/staff', staff('StudentAffairs', 'sa2'))).status).toBe(403);
    expect((await sa.req('PUT', '/api/v1/staff', staff('Operator', 'op-sa'))).status).toBe(403);
    expect((await sa.req('PUT', '/api/v1/employees', { username: 'emp.one', firstName: 'الف', lastName: 'ب' })).body.temporaryPassword).toBeTruthy();
    expect((await nm.req('PUT', '/api/v1/staff', staff('Operator', 'op-nm'))).status).toBe(200);
    expect((await nm.req('PUT', '/api/v1/staff', staff('NutritionManager', 'nm2'))).status).toBe(403);
    expect((await nm.req('PUT', '/api/v1/staff', staff('Finance', 'fin-nm'))).status).toBe(403);
    expect((await su.req('PUT', '/api/v1/staff', staff('SuperAdmin', 'su2'))).status).toBe(403);
    expect((await su.req('PUT', '/api/v1/staff', staff('Finance', 'fin-su'))).status).toBe(200);
  });

  it('bulk employee import returns one-time credentials, stores only hashes', async () => {
    const sa = await as('StudentAffairs', '10.30.0.4');
    const r = await sa.req('POST', '/api/v1/employees/bulk', {
      rows: [
        { username: 'bulk.a', firstName: 'a', lastName: 'b' },
        { username: 'bulk.b', firstName: 'c', lastName: 'd' },
      ],
    });
    expect(r.body.created).toBe(2);
    const pw = (r.body.credentialsCsv as string).split('\n')[1]!.split(',')[2]!;
    const stored = await t.db.execute<{ password_hash: string }>(sql`SELECT password_hash FROM employees WHERE username='bulk.a'`);
    expect(stored.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify((await t.db.execute(sql`SELECT data FROM audit_logs WHERE action='employee.bulk-create'`)).rows)).not.toContain(pw);
    const e = new Client(t.app, '10.30.0.5');
    expect((await e.req('POST', '/api/v1/auth/employee/login', { username: 'bulk.a', password: pw })).body.mustChangePassword).toBe(true);
  });
});

describe('finance', () => {
  it('manual charge is idempotent, capped, cannot go negative, SuperAdmin cannot write', async () => {
    const s = await makeStudent(t.db);
    const fin = await as('Finance', '10.31.0.1');
    const su = await as('SuperAdmin', '10.31.0.2');
    const body = { studentNumber: s.sn, amountRial: 200_000, reason: 'شارژ نقدی در دفتر', idempotencyKey: 'fin-key-0001' };
    expect((await su.req('POST', '/api/v1/finance/adjust', body)).status).toBe(403);
    const a = await fin.req('POST', '/api/v1/finance/adjust', body);
    const b = await fin.req('POST', '/api/v1/finance/adjust', body);
    expect(a.body.balanceRial).toBe(200_000);
    expect(b.body).toMatchObject({ replay: true, balanceRial: 200_000, trackingCode: a.body.trackingCode });
    expect(
      (await fin.req('POST', '/api/v1/finance/adjust', { ...body, amountRial: -300_000, idempotencyKey: 'fin-key-0002', kind: 'ManualAdjust' })).status,
    ).toBe(402);
    expect((await fin.req('POST', '/api/v1/finance/adjust', { ...body, amountRial: 999_999_999, idempotencyKey: 'fin-key-0003' })).status).toBe(400);
    expect((await fin.req('POST', '/api/v1/finance/adjust', { ...body, reason: '', idempotencyKey: 'fin-key-0004' })).status).toBe(400);
    const l = await fin.req('GET', `/api/v1/finance/ledger?search=${s.sn}`);
    expect(l.body.entries).toHaveLength(1);
    expect(l.body.reconciliation.healthy).toBe(true);
  });
});

describe('settings & students', () => {
  it('only SuperAdmin edits settings, with range validation and before/after audit', async () => {
    const su = await as('SuperAdmin', '10.32.0.1');
    const nm = await as('NutritionManager', '10.32.0.2');
    expect((await nm.req('PUT', '/api/v1/settings', { values: { cancel_cutoff_hours: 6 } })).status).toBe(403);
    expect((await su.req('PUT', '/api/v1/settings', { values: { min_gateway_payable_rial: 5 } })).status).toBe(400);
    expect((await su.req('PUT', '/api/v1/settings', { values: { unknown_key: 1 } })).status).toBe(400);
    const ok = await su.req('PUT', '/api/v1/settings', { values: { cancel_cutoff_hours: 6 } });
    expect(ok.body.values.cancel_cutoff_hours).toBe(6);
    const a = await t.db.execute<{ data: { before: number; after: number } }>(
      sql`SELECT data FROM audit_logs WHERE action='settings.update' AND entity_id='cancel_cutoff_hours' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(a.rows[0]!.data).toEqual({ before: 12, after: 6 });
    await su.req('PUT', '/api/v1/settings', { values: { cancel_cutoff_hours: 12 } });
  });

  it('student status change revokes sessions; list never returns raw national id', async () => {
    const s = await makeStudent(t.db);
    const sa = await as('StudentAffairs', '10.32.0.3');
    const sc = new Client(t.app, '10.32.0.4');
    await sc.req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
    const list = await sa.req('GET', `/api/v1/admin/students?search=${s.sn}`);
    expect(JSON.stringify(list.body)).not.toContain(s.nid);
    expect((await sa.req('PATCH', `/api/v1/admin/students/${s.student.id}/status`, { status: 'Graduated' })).status).toBe(200);
    expect((await sc.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });
});
