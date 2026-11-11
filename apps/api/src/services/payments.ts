import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { fail } from '../lib/errors.js';
import { audit } from './audit.js';
import type { PaymentGateway } from './gateway.js';
import { postLedger, systemAccountId } from './ledger.js';
import { reserveInTx, type Customer } from './reserve.js';
import { getSettings, num } from './settings.js';

type Item = { offeringId: string; priceRial: string };
export type ItemResult = { offeringId: string; ok: boolean; code?: string; error?: string };

/** Prices the cart for the customer's group and decides how much existing credit to use and how much goes to the gateway. */
export async function priceCart(db: Db, c: Customer, offeringIds: string[]) {
  const ids = [...new Set(offeringIds)];
  const r = await db.execute<{ id: string; price_rial: bigint | null; status: string; reserve_deadline: string }>(sql`
    SELECT o.id, p.price_rial, o.status, o.reserve_deadline FROM meal_offerings o LEFT JOIN offering_prices p ON p.offering_id=o.id AND p.customer_group=${c.group}
    WHERE o.id = ANY(${`{${ids.join(',')}}`}::uuid[])`);
  if (r.rows.length !== ids.length || r.rows.some((x) => x.price_rial == null || x.status !== 'Published' || new Date(x.reserve_deadline) <= new Date())) {
    fail('BAD_REQUEST', 'برخی از غذاهای سبد دیگر در دسترس نیستند. سبد را بررسی کنید.');
  }
  const items: Item[] = r.rows.map((x) => ({ offeringId: x.id, priceRial: x.price_rial!.toString() }));
  const total = items.reduce((s, i) => s + BigInt(i.priceRial), 0n);
  const bal = (await db.execute<{ balance_rial: bigint }>(sql`SELECT balance_rial FROM accounts WHERE id=${c.accountId}`)).rows[0]!.balance_rial;
  const min = BigInt(num(await getSettings(db), 'min_gateway_payable_rial'));
  let credit = bal < total ? bal : total;
  let payable = total - credit;
  if (payable > 0n && payable < min) {
    credit = total > min ? total - min : 0n;
    payable = total - credit;
  }
  if (payable > 0n && payable < min) fail('BAD_REQUEST', `حداقل مبلغ قابل پرداخت آنلاین ${min.toString()} ریال است.`);
  return { items, total, credit, payable };
}

/** Reserves every item against the wallet, each in its own SAVEPOINT; failed items keep their money as credit. */
async function reserveItems(db: Db, c: Customer, paymentId: string, items: Item[]) {
  const results: ItemResult[] = [];
  await db.transaction(async (tx) => {
    for (const it of items) {
      try {
        const r = await tx.transaction((sp) => reserveInTx(sp, c, it.offeringId, `pay:${paymentId}:${it.offeringId}`, { paymentId }));
        results.push({ offeringId: it.offeringId, ok: true, code: r.code.replace(/^R-/, '') });
      } catch (e) {
        results.push({ offeringId: it.offeringId, ok: false, error: (e as Error).message || 'رزرو انجام نشد.' });
      }
    }
  });
  return results;
}

export async function startCheckout(db: Db, gw: PaymentGateway | null, c: Customer, offeringIds: string[], idempotencyKey: string, callbackUrl: string) {
  const prior = await db.execute<{ id: string; status: string; authority: string | null }>(
    sql`SELECT id, status, authority FROM payments WHERE account_id=${c.accountId} AND items->>'key' = ${idempotencyKey} LIMIT 1`,
  );
  if (prior.rows[0])
    return {
      paymentId: prior.rows[0].id,
      redirectUrl: prior.rows[0].authority && gw ? gw.startPayUrl(prior.rows[0].authority) : null,
      settled: prior.rows[0].status !== 'Pending',
    };
  const cart = await priceCart(db, c, offeringIds);
  if (cart.payable > 0n && !gw) fail('UNAVAILABLE', 'پرداخت آنلاین فعلاً غیرفعال است. برای افزایش اعتبار به امور مالی مراجعه کنید.');
  const ins = await db.execute<{ id: string }>(sql`INSERT INTO payments (account_id, amount_rial, credit_used_rial, items, status)
    VALUES (${c.accountId}, ${cart.payable.toString()}::bigint, ${cart.credit.toString()}::bigint, ${JSON.stringify({ key: idempotencyKey, list: cart.items })}::jsonb, 'Pending') RETURNING id`);
  const paymentId = ins.rows[0]!.id;
  await audit(db, {
    actor: c.actor,
    action: 'payment.start',
    entityType: 'Payment',
    entityId: paymentId,
    data: { total: cart.total.toString(), credit: cart.credit.toString(), payable: cart.payable.toString(), items: cart.items.length },
  });
  if (cart.payable === 0n) {
    // fully covered by existing refund credit — settle immediately, no gateway
    const results = await reserveItems(db, c, paymentId, cart.items);
    await db.execute(sql`UPDATE payments SET status='Paid', settled_at=now(), updated_at=now() WHERE id=${paymentId}`);
    return { paymentId, redirectUrl: null, settled: true, results };
  }
  const { authority } = await gw!.request({
    amountRial: cart.payable,
    description: `رزرو غذا (${cart.items.length} قلم)`,
    callbackUrl: `${callbackUrl}?pid=${paymentId}`,
  });
  await db.execute(sql`UPDATE payments SET authority=${authority}, updated_at=now() WHERE id=${paymentId}`);
  return { paymentId, redirectUrl: gw!.startPayUrl(authority), settled: false };
}

/**
 * Settles a gateway payment exactly once. Verification is ALWAYS performed server-side (even when Status != OK).
 * The payment row is locked for the whole verify+credit step so concurrent callbacks settle once.
 * Verified-but-ledger-failed ⇒ NeedsReview (+ audit alert); no path credits money without a verified payment.
 */
export async function settlePayment(db: Db, gw: PaymentGateway, paymentId: string, authority: string | null) {
  let verified: { ok: boolean; code: number; refId?: string; cardPan?: string } | null = null;
  let customer: Customer | null = null;
  let items: Item[] = [];
  try {
    const out = await db.transaction(async (tx) => {
      const p = (
        await tx.execute<{ id: string; status: string; authority: string | null; amount_rial: bigint; account_id: string; items: { list: Item[] } }>(
          sql`SELECT id, status, authority, amount_rial, account_id, items FROM payments WHERE id=${paymentId} FOR UPDATE`,
        )
      ).rows[0];
      if (!p) fail('NOT_FOUND', 'پرداخت پیدا نشد.');
      if (p.status !== 'Pending') return { already: true as const, status: p.status };
      if (!p.authority || (authority && authority !== p.authority)) fail('BAD_REQUEST', 'اطلاعات بازگشت از درگاه نامعتبر است.');
      const v = await gw.verify({ amountRial: BigInt(p.amount_rial), authority: p.authority });
      verified = { ok: v.code === 100 || v.code === 101, ...v };
      if (!verified.ok) {
        await tx.execute(sql`UPDATE payments SET status='Failed', gateway_code=${v.code}, updated_at=now() WHERE id=${p.id}`);
        return { already: false as const, status: 'Failed' };
      }
      const acct = await tx.execute<{ student_id: string | null; employee_id: string | null }>(
        sql`SELECT student_id, employee_id FROM accounts WHERE id=${p.account_id}`,
      );
      customer = {
        accountId: p.account_id,
        group: acct.rows[0]!.student_id ? 'Student' : 'Employee',
        actor: acct.rows[0]!.student_id ? `student:${acct.rows[0]!.student_id}` : `employee:${acct.rows[0]!.employee_id}`,
      };
      items = p.items.list;
      const gwAcct = await systemAccountId(tx, 'payment-gateway');
      await postLedger(tx, {
        type: 'OnlinePayment',
        idempotencyKey: `payment:${p.id}`,
        actor: 'gateway',
        reason: `پرداخت آنلاین (کد پیگیری درگاه ${v.refId ?? '-'})`,
        paymentId: p.id,
        lines: [
          { accountId: p.account_id, amount: BigInt(p.amount_rial) },
          { accountId: gwAcct, amount: -BigInt(p.amount_rial) },
        ],
      });
      await tx.execute(
        sql`UPDATE payments SET status='Paid', gateway_code=${v.code}, ref_id=${v.refId ?? null}, card_pan=${v.cardPan ?? null}, settled_at=now(), updated_at=now() WHERE id=${p.id}`,
      );
      await audit(tx, { actor: 'gateway', action: 'payment.verified', entityType: 'Payment', entityId: p.id, data: { code: v.code, refId: v.refId ?? null } });
      return { already: false as const, status: 'Paid' };
    });
    if (out.status !== 'Paid' || out.already) return { status: out.status, results: [] as ItemResult[] };
  } catch (e) {
    const v = verified as { ok: boolean; code: number; refId?: string } | null;
    if (v?.ok) {
      await db.execute(
        sql`UPDATE payments SET status='NeedsReview', gateway_code=${v.code}, ref_id=${v.refId ?? null}, review_note=${'verify OK but ledger posting failed'}, updated_at=now() WHERE id=${paymentId} AND status='Pending'`,
      );
      await audit(db, {
        actor: 'system',
        action: 'payment.needs-review',
        entityType: 'Payment',
        entityId: paymentId,
        data: { refId: v.refId ?? null, error: (e as Error).message.slice(0, 200) },
      });
      return { status: 'NeedsReview', results: [] as ItemResult[] };
    }
    throw e;
  }
  const results = await reserveItems(db, customer!, paymentId, items);
  const failed = results.filter((r) => !r.ok).length;
  if (failed)
    await db.execute(
      sql`INSERT INTO notifications (account_id, title, body, kind) VALUES (${(customer as unknown as Customer).accountId}, 'رزرو ناقص', ${`${failed} قلم از سبد شما رزرو نشد و مبلغ آن به اعتبار شما اضافه شد.`}, 'refund')`,
    );
  return { status: 'Paid', results };
}
