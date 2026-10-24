import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { requirePrincipal } from '../lib/auth.js';
import { currentCustomer, iso, n } from '../lib/customer.js';
import { fail } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import type { PaymentGateway } from '../services/gateway.js';
import { postLedger, systemAccountId } from '../services/ledger.js';
import { settlePayment, startCheckout } from '../services/payments.js';

export function paymentRoutes(app: FastifyInstance, db: Db, env: Env, gw: PaymentGateway | null) {
  const callbackUrl = `${env.PUBLIC_BASE_URL}/api/v1/payments/zarinpal/callback`;

  app.post('/api/v1/payments/checkout/start', { config: { access: 'selfService', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const c = await currentCustomer(db, req);
    const b = z.object({ offeringIds: z.array(z.string().uuid()).min(1).max(30), idempotencyKey: z.string().min(8).max(80) }).parse(req.body);
    return startCheckout(db, gw, c, b.offeringIds, b.idempotencyKey, callbackUrl);
  });

  // Public: the browser returns here from the gateway. Verification happens server-side regardless of Status.
  app.get('/api/v1/payments/zarinpal/callback', { config: { access: 'public' } }, async (req, reply) => {
    const q = z.object({ pid: z.string().uuid(), Authority: z.string().max(100).optional(), Status: z.string().max(10).optional() }).safeParse(req.query);
    if (!q.success) return reply.redirect(`${env.PUBLIC_BASE_URL}/payment/result?error=1`, 303);
    if (gw) await settlePayment(db, gw, q.data.pid, q.data.Authority ?? null).catch((e) => req.log.error({ err: e, pid: q.data.pid }, 'settle failed'));
    return reply.redirect(`${env.PUBLIC_BASE_URL}/payment/result?pid=${q.data.pid}`, 303);
  });

  app.post('/api/v1/payments/result', { config: { access: 'selfService' } }, async (req) => {
    const c = await currentCustomer(db, req);
    const { paymentId } = z.object({ paymentId: z.string().uuid() }).parse(req.body);
    const p = (
      await db.execute<Record<string, unknown>>(
        sql`SELECT id, status, amount_rial, credit_used_rial, ref_id, items, created_at FROM payments WHERE id=${paymentId} AND account_id=${c.accountId}`,
      )
    ).rows[0];
    if (!p) fail('NOT_FOUND', 'پرداخت پیدا نشد.');
    const res = await db.execute<{ offering_id: string; code: string }>(sql`SELECT offering_id, code FROM reservations WHERE payment_id=${paymentId}`);
    const list = (p.items as { list: { offeringId: string; priceRial: string }[] }).list;
    return {
      paymentId: p.id,
      status: p.status,
      paidRial: n(p.amount_rial as bigint),
      creditUsedRial: n(p.credit_used_rial as bigint),
      trackingCode: p.ref_id ?? null,
      createdAt: iso(p.created_at as Date),
      results: list.map((i) => {
        const r = res.rows.find((x) => x.offering_id === i.offeringId);
        return {
          offeringId: i.offeringId,
          ok: !!r,
          code: r?.code.replace(/^R-/, ''),
          error: r || p.status !== 'Paid' ? undefined : 'رزرو انجام نشد؛ مبلغ به اعتبار شما اضافه شد.',
        };
      }),
    };
  });

  app.get('/api/v1/payments/needs-review', { config: { access: 'paymentsReview' } }, async () => {
    const r = await db.execute<
      Record<string, unknown>
    >(sql`SELECT p.id, p.amount_rial, p.ref_id, p.authority, p.review_note, p.created_at, COALESCE(s.student_number, e.username) AS owner
      FROM payments p JOIN accounts a ON a.id=p.account_id LEFT JOIN students s ON s.id=a.student_id LEFT JOIN employees e ON e.id=a.employee_id WHERE p.status='NeedsReview' ORDER BY p.created_at`);
    return {
      payments: r.rows.map((x) => ({
        id: x.id,
        amountRial: n(x.amount_rial as bigint),
        refId: x.ref_id,
        authority: x.authority,
        note: x.review_note ?? '',
        owner: x.owner,
        createdAt: iso(x.created_at as Date),
      })),
    };
  });

  /** SuperAdmin resolution: credit the verified amount to the customer's wallet, or mark failed (with note). */
  app.post('/api/v1/payments/:id/resolve', { config: { access: 'paymentsReview' } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ action: z.enum(['credit', 'mark-failed']), note: z.string().trim().min(5).max(500) }).parse(req.body);
    return db.transaction(async (tx) => {
      const row = (
        await tx.execute<{ account_id: string; amount_rial: bigint; status: string }>(
          sql`SELECT account_id, amount_rial, status FROM payments WHERE id=${id} FOR UPDATE`,
        )
      ).rows[0];
      if (!row || row.status !== 'NeedsReview') fail('CONFLICT', 'این پرداخت در وضعیت بررسی نیست.');
      if (b.action === 'credit') {
        const gwAcct = await systemAccountId(tx, 'payment-gateway');
        await postLedger(tx, {
          type: 'OnlinePayment',
          idempotencyKey: `payment:${id}`,
          actor: p.actor,
          reason: `تعیین‌تکلیف پرداخت: ${b.note}`,
          paymentId: id,
          lines: [
            { accountId: row.account_id, amount: BigInt(row.amount_rial) },
            { accountId: gwAcct, amount: -BigInt(row.amount_rial) },
          ],
        });
      }
      await tx.execute(
        sql`UPDATE payments SET status=${b.action === 'credit' ? 'Paid' : 'Failed'}::payment_status, review_note=${b.note}, reviewed_by=${p.id}, settled_at=now(), updated_at=now() WHERE id=${id}`,
      );
      await audit(tx, {
        actor: p.actor,
        action: 'payment.resolve',
        entityType: 'Payment',
        entityId: id,
        data: { action: b.action, note: b.note },
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  app.post('/api/v1/payments/reconcile', { config: { access: 'paymentsReview' } }, async () => {
    if (!gw) return { checked: 0, results: [] };
    const r = await db.execute<{ id: string }>(
      sql`SELECT id FROM payments WHERE status='Pending' AND authority IS NOT NULL AND created_at < now() - interval '10 minutes' ORDER BY created_at LIMIT 50`,
    );
    const results = [];
    for (const row of r.rows)
      results.push({
        id: row.id,
        ...(await settlePayment(db, gw, row.id, null)
          .then((x) => ({ status: x.status }))
          .catch((e) => ({ status: 'error', error: (e as Error).message }))),
      });
    return { checked: r.rows.length, results };
  });
}
