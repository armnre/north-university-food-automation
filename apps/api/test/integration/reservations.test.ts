import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { reserve } from '../../src/services/reserve.js';
import { Client, testApp } from '../helpers/app.js';
import { credit, makeEmployee, makeOffering, makeStaff, makeStudent, STAFF_PASSWORD } from '../helpers/factory.js';

let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

async function ledgerInvariants() {
  const unbalanced = await t.db.execute(sql`SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_rial) <> 0`);
  const drift = await t.db.execute(
    sql`SELECT a.id FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id, a.balance_rial HAVING a.balance_rial <> COALESCE(sum(e.amount_rial),0)`,
  );
  const neg = await t.db.execute(sql`SELECT id FROM accounts WHERE kind='Customer' AND balance_rial < 0`);
  expect(unbalanced.rows).toHaveLength(0);
  expect(drift.rows).toHaveLength(0);
  expect(neg.rows).toHaveLength(0);
}
const login = async (sn: string, nid: string, ip: string) => {
  const c = new Client(t.app, ip);
  await c.req('POST', '/api/v1/auth/student/login', { studentNumber: sn, nationalId: nid });
  return c;
};

describe('reservation engine', () => {
  it('reserves via API, debits wallet with balance_after, shows in menu & reservations; idempotent replay', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 300_000n);
    const off = await makeOffering(t.db, { student: 120_000 });
    const c = await login(s.sn, s.nid, '10.20.0.1');
    const r1 = await c.req('POST', '/api/v1/me/reserve', { offeringId: off, idempotencyKey: 'key-00000001' });
    expect(r1.status).toBe(200);
    const r2 = await c.req('POST', '/api/v1/me/reserve', { offeringId: off, idempotencyKey: 'key-00000001' });
    expect(r2.body).toMatchObject({ reservationId: r1.body.reservationId, replay: true });
    const w = await c.req('GET', '/api/v1/me/wallet');
    expect(w.body.balanceRial).toBe(180_000);
    expect(w.body.transactions[0].runningBalance).toBe(180_000);
    const dup = await c.req('POST', '/api/v1/me/reserve', { offeringId: off, idempotencyKey: 'key-00000002' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('قبلاً رزرو');
    const menu = await c.req('GET', `/api/v1/me/menu?from=2020-01-01&to=2100-01-01`);
    expect(menu.body.offerings.find((o: { id: string }) => o.id === off).myStatus).toBe('Reserved');
    const list = await c.req('GET', '/api/v1/me/reservations');
    expect(list.body.reservations[0].qrToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(list.body.reservations[0].canCancel).toBe(false); // disabled by default
    await ledgerInvariants();
  });

  it('insufficient balance rolls back capacity; missing group price → unavailable', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 50_000n);
    const off = await makeOffering(t.db, { student: 100_000, employee: null });
    await expect(reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, 'poor-1')).rejects.toThrow(/کافی/);
    expect((await t.db.execute<{ reserved_count: number }>(sql`SELECT reserved_count FROM meal_offerings WHERE id=${off}`)).rows[0]!.reserved_count).toBe(0);
    const e = await makeEmployee(t.db);
    const acct = (await t.db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE employee_id=${e.id}`)).rows[0]!.id;
    await expect(reserve(t.db, { accountId: acct, group: 'Employee', actor: 't' }, off, 'emp-1')).rejects.toThrow(/گروه شما/);
  });

  it('employees pay their group price', async () => {
    const e = await makeEmployee(t.db);
    const acct = (await t.db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE employee_id=${e.id}`)).rows[0]!.id;
    await credit(t.db, acct, 500_000n);
    const off = await makeOffering(t.db, { student: 100_000, employee: 250_000 });
    const r = await reserve(t.db, { accountId: acct, group: 'Employee', actor: 't' }, off, 'emp-price-1');
    expect(r.priceRial).toBe(250_000n);
  });

  it('50 concurrent reservations for capacity 10 → exactly 10 succeed, ledger balanced', async () => {
    const off = await makeOffering(t.db, { capacity: 10, student: 10_000 });
    const studs = await Promise.all(Array.from({ length: 50 }, () => makeStudent(t.db)));
    for (const s of studs) await credit(t.db, s.account.id, 10_000n);
    const res = await Promise.allSettled(
      studs.map((s, i) => reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, `conc-${i}-${off}`)),
    );
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const o = (await t.db.execute<{ reserved_count: number }>(sql`SELECT reserved_count FROM meal_offerings WHERE id=${off}`)).rows[0]!;
    expect(o.reserved_count).toBe(10);
    await ledgerInvariants();
  });

  it('same student, same key, concurrent → one reservation', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 100_000n);
    const off = await makeOffering(t.db, { student: 10_000 });
    const res = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, `same-${off}`)),
    );
    const ids = new Set(res.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ reservationId: string }>).value.reservationId));
    expect(ids.size).toBe(1);
    expect((await t.db.execute<{ balance_rial: bigint }>(sql`SELECT balance_rial FROM accounts WHERE id=${s.account.id}`)).rows[0]!.balance_rial).toBe(90_000n);
  });
});

describe('cancellation & sold-out', () => {
  it('student cancel is forbidden by default, works when enabled, refunds and frees capacity', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 100_000n);
    const off = await makeOffering(t.db, { student: 40_000, days: 3 });
    const r = await reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, `c-${off}`);
    const c = await login(s.sn, s.nid, '10.21.0.1');
    expect((await c.req('POST', `/api/v1/me/reservations/${r.reservationId}/cancel`)).status).toBe(403);
    await t.db.execute(sql`UPDATE system_settings SET value='true'::jsonb WHERE key='student_cancellation_enabled'`);
    try {
      const ok = await c.req('POST', `/api/v1/me/reservations/${r.reservationId}/cancel`);
      expect(ok.body).toMatchObject({ ok: true, refundRial: 40_000 });
      expect((await c.req('POST', `/api/v1/me/reservations/${r.reservationId}/cancel`)).body.replay).toBe(true);
      expect((await c.req('GET', '/api/v1/me/wallet')).body.balanceRial).toBe(100_000);
      // another customer cannot cancel someone else's reservation (IDOR)
      const other = await makeStudent(t.db);
      const oc = await login(other.sn, other.nid, '10.21.0.2');
      expect((await oc.req('POST', `/api/v1/me/reservations/${r.reservationId}/cancel`)).status).toBe(404);
    } finally {
      await t.db.execute(sql`UPDATE system_settings SET value='false'::jsonb WHERE key='student_cancellation_enabled'`);
    }
    await ledgerInvariants();
  });

  it('"sold out" bulk-refunds all reservations with typed confirmation', async () => {
    const off = await makeOffering(t.db, { capacity: 150, student: 5_000 });
    const studs = await Promise.all(Array.from({ length: 120 }, () => makeStudent(t.db)));
    for (const [i, s] of studs.entries()) {
      await credit(t.db, s.account.id, 5_000n);
      await reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, `so-${i}-${off}`);
    }
    const nm = await makeStaff(t.db, 'NutritionManager');
    const c = new Client(t.app, '10.22.0.1');
    await c.req('POST', '/api/v1/auth/staff/login', { username: nm.username, password: STAFF_PASSWORD });
    expect((await c.req('POST', `/api/v1/offerings/${off}/sold-out`, { reason: 'غذا تمام شد', confirm: 'no' })).status).toBe(400);
    const r = await c.req('POST', `/api/v1/offerings/${off}/sold-out`, { reason: 'غذا تمام شد', confirm: 'تایید' });
    expect(r.body).toEqual({ cancelled: 120, refundedRial: 600_000 });
    expect((await t.db.execute<{ reserved_count: number }>(sql`SELECT reserved_count FROM meal_offerings WHERE id=${off}`)).rows[0]!.reserved_count).toBe(0);
    await ledgerInvariants();
  });
});

describe('delivery', () => {
  async function ticket(cafeteriaId?: string) {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 10_000n);
    const off = await makeOffering(t.db, { student: 10_000, days: 0, deadlineMinutes: -1, cafeteriaId }).catch(async () => null);
    return { s, off };
  }
  it('two concurrent confirms → exactly one delivered; wrong cafeteria rejected; manual code works', async () => {
    // build a today offering whose window is open now by writing times directly
    const caf = (await t.db.execute<{ id: string }>(sql`INSERT INTO cafeterias (name) VALUES ('سلف تست') RETURNING id`)).rows[0]!.id;
    const off = await makeOffering(t.db, { student: 10_000, cafeteriaId: caf });
    await t.db.execute(
      sql`UPDATE meal_offerings SET service_date=(now() AT TIME ZONE 'Asia/Tehran')::date, reserve_deadline=now()+interval '1 min', meal_starts_at=now()+interval '2 min', meal_ends_at=now()+interval '1 hour' WHERE id=${off}`,
    );
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 10_000n);
    const r = await reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, `d-${off}`);
    const token = (await t.db.execute<{ qr_token: string }>(sql`SELECT qr_token FROM reservations WHERE id=${r.reservationId}`)).rows[0]!.qr_token;
    const op = await makeStaff(t.db, 'Operator', { cafeteriaId: caf });
    const op2 = await makeStaff(t.db, 'Operator', { cafeteriaId: caf });
    const wrong = await makeStaff(t.db, 'Operator', {
      cafeteriaId: (await t.db.execute<{ id: string }>(sql`INSERT INTO cafeterias (name) VALUES ('دیگر') RETURNING id`)).rows[0]!.id,
    });
    const cs = await Promise.all(
      [op, op2, wrong].map(async (u, i) => {
        const c = new Client(t.app, `10.23.0.${i + 1}`);
        await c.req('POST', '/api/v1/auth/staff/login', { username: u.username, password: STAFF_PASSWORD });
        return c;
      }),
    );
    expect((await cs[2]!.req('POST', '/api/v1/delivery/scan', { qrToken: token })).body.state).toBe('wrongCafeteria');
    expect((await cs[0]!.req('POST', '/api/v1/delivery/scan', { qrToken: `r-${r.code.slice(2).toLowerCase()}` })).body.state).toBe('ready');
    const [a, b] = await Promise.all([
      cs[0]!.req('POST', '/api/v1/delivery/confirm', { qrToken: token }),
      cs[1]!.req('POST', '/api/v1/delivery/confirm', { qrToken: token }),
    ]);
    expect([a.body.state, b.body.state].sort()).toEqual(['already', 'delivered']);
    const third = await cs[0]!.req('POST', '/api/v1/delivery/confirm', { qrToken: r.code.slice(2) });
    expect(third.body.state).toBe('already');
    expect(third.body.info.deliveredBy).toBeTruthy();
    const logs = await t.db.execute(sql`SELECT outcome FROM deliveries WHERE reservation_id=${r.reservationId}`);
    expect(logs.rows.map((x) => (x as { outcome: string }).outcome).sort()).toEqual(['Accepted', 'AlreadyDelivered', 'AlreadyDelivered']); // every confirm attempt is logged; /scan is a read-only preview
  });

  it('offline manifest never contains raw tokens; two offline devices → one Accepted, one OfflineConflict; replay idempotent', async () => {
    const caf = (await t.db.execute<{ id: string }>(sql`INSERT INTO cafeterias (name) VALUES ('سلف آفلاین') RETURNING id`)).rows[0]!.id;
    const off = await makeOffering(t.db, { student: 0, cafeteriaId: caf });
    await t.db.execute(
      sql`UPDATE meal_offerings SET service_date=(now() AT TIME ZONE 'Asia/Tehran')::date, reserve_deadline=now()+interval '1 min', meal_starts_at=now()+interval '2 min', meal_ends_at=now()+interval '1 hour' WHERE id=${off}`,
    );
    const s = await makeStudent(t.db);
    const r = await reserve(t.db, { accountId: s.account.id, group: 'Student', actor: 't' }, off, `o-${off}`);
    const token = (await t.db.execute<{ qr_token: string }>(sql`SELECT qr_token FROM reservations WHERE id=${r.reservationId}`)).rows[0]!.qr_token;
    const op = await makeStaff(t.db, 'Operator', { cafeteriaId: caf });
    const c = new Client(t.app, '10.24.0.1');
    await c.req('POST', '/api/v1/auth/staff/login', { username: op.username, password: STAFF_PASSWORD });
    const m = await c.req('GET', '/api/v1/delivery/offline-manifest');
    expect(JSON.stringify(m.body)).not.toContain(token);
    expect(m.body.entries).toHaveLength(1);
    const e1 = { clientEventId: crypto.randomUUID(), qrToken: token, scannedAt: new Date().toISOString() };
    const e2 = { clientEventId: crypto.randomUUID(), qrToken: token, scannedAt: new Date().toISOString() };
    const s1 = await c.req('POST', '/api/v1/delivery/sync', { deviceId: 'device-aaaa', events: [e1] });
    const s2 = await c.req('POST', '/api/v1/delivery/sync', { deviceId: 'device-bbbb', events: [e2] });
    expect(s1.body.results[0].outcome).toBe('Accepted');
    expect(s2.body.results[0].outcome).toBe('OfflineConflict');
    const again = await c.req('POST', '/api/v1/delivery/sync', { deviceId: 'device-aaaa', events: [e1] });
    expect(again.body.results[0].replay).toBe(true);
  });
  void ticket;
});
