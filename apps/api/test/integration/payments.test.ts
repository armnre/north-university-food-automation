import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PaymentGateway } from '../../src/services/gateway.js';
import { settlePayment } from '../../src/services/payments.js';
import { Client, testApp } from '../helpers/app.js';
import { testPool } from '../helpers/db.js';
import { credit, makeOffering, makeStaff, makeStudent, STAFF_PASSWORD } from '../helpers/factory.js';

class FakeGateway implements PaymentGateway {
  name = 'fake';
  verifyCalls = 0;
  nextCode = 100;
  verified = new Set<string>();
  async request() {
    return { authority: `A${Math.random().toString(36).slice(2).padEnd(30, '0')}` };
  }
  async verify({ authority }: { authority: string }) {
    this.verifyCalls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.nextCode !== 100) return { code: this.nextCode };
    const code = this.verified.has(authority) ? 101 : 100;
    this.verified.add(authority);
    return { code, refId: '123456' };
  }
  startPayUrl(a: string) {
    return `https://gateway.test/StartPay/${a}`;
  }
}
const gw = new FakeGateway();
let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  t = await testApp({}, gw);
});
afterAll(async () => {
  await t.close();
});
const login = async (s: Awaited<ReturnType<typeof makeStudent>>, ip: string) => {
  const c = new Client(t.app, ip);
  await c.req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
  return c;
};
const bal = async (id: string) => (await t.db.execute<{ balance_rial: bigint }>(sql`SELECT balance_rial FROM accounts WHERE id=${id}`)).rows[0]!.balance_rial;

describe('zarinpal cart checkout', () => {
  it('uses existing credit, sends the rest to gateway, settles once under 20 concurrent callbacks', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 30_000n);
    const o1 = await makeOffering(t.db, { student: 50_000 });
    const o2 = await makeOffering(t.db, { student: 40_000 });
    const c = await login(s, '10.40.0.1');
    const st = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o1, o2], idempotencyKey: 'cart-00000001' });
    expect(st.body.redirectUrl).toContain('StartPay');
    const p = (
      await t.db.execute<{ amount_rial: bigint; credit_used_rial: bigint; authority: string }>(
        sql`SELECT amount_rial, credit_used_rial, authority FROM payments WHERE id=${st.body.paymentId}`,
      )
    ).rows[0]!;
    expect(p.amount_rial).toBe(60_000n);
    expect(p.credit_used_rial).toBe(30_000n);
    const before = gw.verifyCalls;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        t.app.inject({ method: 'GET', url: `/api/v1/payments/zarinpal/callback?pid=${st.body.paymentId}&Authority=${p.authority}&Status=OK` }),
      ),
    );
    expect(results.every((r) => r.statusCode === 303)).toBe(true);
    expect(gw.verifyCalls - before).toBe(1); // row lock ⇒ single verify/settlement
    const ledger = await t.db.execute(sql`SELECT 1 FROM ledger_transactions WHERE payment_id=${st.body.paymentId} AND type='OnlinePayment'`);
    expect(ledger.rows).toHaveLength(1);
    const res = await c.req('POST', '/api/v1/payments/result', { paymentId: st.body.paymentId });
    expect(res.body.status).toBe('Paid');
    expect(res.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(await bal(s.account.id)).toBe(0n);
  });

  it('verifies even when Status=NOK; failed verify credits nothing', async () => {
    const s = await makeStudent(t.db);
    const o = await makeOffering(t.db, { student: 50_000 });
    const c = await login(s, '10.40.0.2');
    const st = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o], idempotencyKey: 'cart-00000002' });
    gw.nextCode = -51;
    const before = gw.verifyCalls;
    await t.app.inject({ method: 'GET', url: `/api/v1/payments/zarinpal/callback?pid=${st.body.paymentId}&Status=NOK` });
    gw.nextCode = 100;
    expect(gw.verifyCalls - before).toBe(1);
    expect((await c.req('POST', '/api/v1/payments/result', { paymentId: st.body.paymentId })).body.status).toBe('Failed');
    expect(await bal(s.account.id)).toBe(0n);
  });

  it('full credit ⇒ settles instantly without gateway; a sold-out item becomes credit', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 100_000n);
    const o1 = await makeOffering(t.db, { student: 30_000 });
    const full = await makeOffering(t.db, { student: 20_000, capacity: 1 });
    const other = await makeStudent(t.db);
    await credit(t.db, other.account.id, 20_000n);
    const c = await login(s, '10.40.0.3');
    // price the cart while `full` still has room, then another customer takes the last seat — simulated by reserving directly
    const { reserve } = await import('../../src/services/reserve.js');
    await reserve(t.db, { accountId: other.account.id, group: 'Student', actor: 't' }, full, `take-${full}`);
    await t.db.execute(sql`UPDATE meal_offerings SET capacity=1 WHERE id=${full}`);
    const st = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o1, full], idempotencyKey: 'cart-00000003' });
    expect(st.body.settled).toBe(true);
    expect(st.body.redirectUrl).toBeNull();
    expect(st.body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1);
    expect(await bal(s.account.id)).toBe(70_000n);
  });

  it('enforces the minimum gateway amount by adjusting credit usage', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 45_000n);
    const o = await makeOffering(t.db, { student: 50_000 });
    const c = await login(s, '10.40.0.4');
    const st = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o], idempotencyKey: 'cart-00000004' });
    const p = (
      await t.db.execute<{ amount_rial: bigint; credit_used_rial: bigint }>(
        sql`SELECT amount_rial, credit_used_rial FROM payments WHERE id=${st.body.paymentId}`,
      )
    ).rows[0]!;
    expect(p.amount_rial).toBe(10_000n);
    expect(p.credit_used_rial).toBe(40_000n);
  });

  it('verify OK but ledger failure ⇒ NeedsReview; SuperAdmin resolves by crediting', async () => {
    const s = await makeStudent(t.db);
    const o = await makeOffering(t.db, { student: 50_000 });
    const c = await login(s, '10.40.0.5');
    const st = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o], idempotencyKey: 'cart-00000005' });
    const mig = testPool('migrator');
    await mig.query(`UPDATE accounts SET code='payment-gateway-x' WHERE code='payment-gateway'`);
    try {
      expect((await settlePayment(t.db, gw, st.body.paymentId, null)).status).toBe('NeedsReview');
    } finally {
      await mig.query(`UPDATE accounts SET code='payment-gateway' WHERE code='payment-gateway-x'`);
      await mig.end();
    }
    expect(await bal(s.account.id)).toBe(0n);
    const su = await makeStaff(t.db, 'SuperAdmin');
    const sc = new Client(t.app, '10.40.0.6');
    await sc.req('POST', '/api/v1/auth/staff/login', { username: su.username, password: STAFF_PASSWORD });
    expect((await sc.req('GET', '/api/v1/payments/needs-review')).body.payments.some((x: { id: string }) => x.id === st.body.paymentId)).toBe(true);
    expect((await sc.req('POST', `/api/v1/payments/${st.body.paymentId}/resolve`, { action: 'credit', note: 'تأیید شد با رسید درگاه' })).status).toBe(200);
    expect(await bal(s.account.id)).toBe(50_000n);
  });
});

describe('payments disabled', () => {
  it('without a gateway, online payment is unavailable with finance guidance', async () => {
    const x = await testApp({}, null);
    const s = await makeStudent(x.db);
    const o = await makeOffering(x.db, { student: 50_000 });
    const c = new Client(x.app, '10.41.0.1');
    await c.req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
    const r = await c.req('POST', '/api/v1/payments/checkout/start', { offeringIds: [o], idempotencyKey: 'cart-00000006' });
    expect(r.status).toBe(503);
    expect(r.body.error.message).toContain('امور مالی');
    await x.close();
  });
});
