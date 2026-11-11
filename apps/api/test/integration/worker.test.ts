import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PaymentGateway } from '../../src/services/gateway.js';
import { reconcilePendingPayments, reconcileLedger, cleanup } from '../../src/jobs/jobs.js';
import { runJob, tehranNow } from '../../src/jobs/runner.js';
import { settlePayment } from '../../src/services/payments.js';
import { Client, testApp } from '../helpers/app.js';
import { makeOffering, makeStudent } from '../helpers/factory.js';

class Gw implements PaymentGateway {
  name = 'fake';
  verified = new Set<string>();
  mode: 'ok' | 'fail' | 'network' = 'ok';
  async request() {
    return { authority: `A${Math.random().toString(36).slice(2).padEnd(30, '0')}` };
  }
  async verify({ authority }: { authority: string }) {
    if (this.mode === 'network') throw new Error('ETIMEDOUT');
    if (this.mode === 'fail') return { code: -51 };
    const code = this.verified.has(authority) ? 101 : 100;
    this.verified.add(authority);
    return { code, refId: '999' };
  }
  startPayUrl(a: string) {
    return `https://gateway.test/StartPay/${a}`;
  }
}
const gw = new Gw();
const log = { info: () => {}, error: () => {} };
let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  t = await testApp({}, gw);
});
afterAll(async () => t.close());

async function pendingPayment(ip: string) {
  const s = await makeStudent(t.db);
  const o = await makeOffering(t.db, { student: 50_000 });
  const c = new Client(t.app, ip);
  await c.req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
  const st = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o], idempotencyKey: `job-${Math.random().toString(36).slice(2, 12)}` });
  const id = st.body.paymentId as string;
  await t.db.execute(sql`UPDATE payments SET created_at = now() - interval '15 minutes' WHERE id=${id}`);
  return { id, s, o };
}
const count = async (q: ReturnType<typeof sql>) => Number((await t.db.execute<{ n: number }>(q)).rows[0]!.n);

describe('reconcile-pending-payments', () => {
  it('settles a gateway-paid payment whose callback never came, exactly once', async () => {
    gw.mode = 'ok';
    const { id, s, o } = await pendingPayment('10.90.0.1');
    const r1 = await reconcilePendingPayments(t.db, gw);
    expect(r1.paid).toBeGreaterThanOrEqual(1);
    expect((await t.db.execute<{ status: string }>(sql`SELECT status FROM payments WHERE id=${id}`)).rows[0]!.status).toBe('Paid');
    const resv = sql`SELECT count(*)::int n FROM reservations WHERE account_id=${s.account.id} AND offering_id=${o}`;
    expect(await count(resv)).toBe(1);
    // second run + late callback: no duplicates
    await reconcilePendingPayments(t.db, gw);
    const late = await settlePayment(t.db, gw, id, null).catch((e) => ({ status: 'err:' + (e as Error).message }));
    expect(late.status).toBe('Paid');
    expect(await count(resv)).toBe(1);
    expect(await count(sql`SELECT count(*)::int n FROM ledger_transactions WHERE idempotency_key=${'payment:' + id}`)).toBe(1);
  });

  it('marks gateway-declined payments Failed and keeps network errors Pending', async () => {
    const a = await pendingPayment('10.90.0.2');
    gw.mode = 'network';
    const r = await reconcilePendingPayments(t.db, gw);
    expect(r.retry).toBeGreaterThanOrEqual(1);
    expect((await t.db.execute<{ status: string }>(sql`SELECT status FROM payments WHERE id=${a.id}`)).rows[0]!.status).toBe('Pending');
    gw.mode = 'fail';
    await reconcilePendingPayments(t.db, gw);
    expect((await t.db.execute<{ status: string }>(sql`SELECT status FROM payments WHERE id=${a.id}`)).rows[0]!.status).toBe('Failed');
    gw.mode = 'ok';
  });

  it('skips when online payment is disabled', async () => {
    expect(await reconcilePendingPayments(t.db, null)).toEqual({ skipped: 'online payment disabled' });
  });
});

describe('runner', () => {
  it('two concurrent workers: only one executes, and the run is recorded', async () => {
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
      return {};
    };
    const [a, b] = await Promise.all([runJob(t.db, t.pool, 'lock-test', slow, log), runJob(t.db, t.pool, 'lock-test', slow, log)]);
    expect(calls).toBe(1);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect(await count(sql`SELECT count(*)::int n FROM job_runs WHERE job='lock-test' AND ok`)).toBeGreaterThanOrEqual(1);
  });

  it('records failures in job_runs', async () => {
    const r = await runJob(
      t.db,
      t.pool,
      'fail-test',
      async () => {
        throw new Error('boom');
      },
      log,
    );
    expect(r?.ok).toBe(false);
  });

  it('Tehran midnight boundary', () => {
    expect(tehranNow(new Date('2026-10-23T20:29:00Z'))).toMatchObject({ date: '2026-10-23', hour: 23, minute: 59 });
    expect(tehranNow(new Date('2026-10-23T20:30:00Z'))).toMatchObject({ date: '2026-10-24', hour: 0, minute: 0 });
  });
});

describe('nightly jobs', () => {
  it('ledger reconciliation finds no mismatch on a consistent db', async () => {
    expect(await reconcileLedger(t.db)).toEqual({ badAccounts: 0, badTransactions: 0 });
  });
  it('cleanup runs', async () => {
    const r = await cleanup(t.db);
    expect(r).toHaveProperty('sessions');
  });
});
