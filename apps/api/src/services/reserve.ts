import { sql } from 'drizzle-orm';
import { tehranDate } from '@food/shared';
import type { Db, Tx } from '../db/client.js';
import { randomCode, randomToken } from '../lib/crypto.js';
import { AppError, fail } from '../lib/errors.js';
import { toDate } from '../lib/customer.js';
import { audit } from './audit.js';
import { postLedger, systemAccountId } from './ledger.js';

export type Customer = { accountId: string; group: 'Student' | 'Employee'; actor: string };
export type ReserveResult = { reservationId: string; code: string; priceRial: bigint; replay: boolean };

const isUniqueViolation = (e: unknown, constraint: string) => {
  const err = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
  return err?.code === '23505' && err.constraint === constraint;
};

/**
 * Reserves one offering inside the caller's transaction (all-or-nothing):
 * lock account → lock offering → validate (Published, Tehran service day, window, not started) →
 * price for the customer's group → atomic capacity increment → ledger debit (balance check) →
 * reservation + history + audit. `payFrom` lets checkout debit a payment-clearing account instead of the wallet.
 */
export async function reserveInTx(
  tx: Tx,
  c: Customer,
  offeringId: string,
  idempotencyKey: string,
  opts: { paymentId?: string; now?: Date } = {},
): Promise<ReserveResult> {
  const prior = await tx.execute<{ id: string; code: string; price_rial: bigint; status: string }>(
    sql`SELECT id, code, price_rial, status FROM reservations WHERE idempotency_key = ${idempotencyKey}`,
  );
  if (prior.rows[0]) return { reservationId: prior.rows[0].id, code: prior.rows[0].code, priceRial: prior.rows[0].price_rial, replay: true };

  const now = opts.now ?? new Date();
  const acct = await tx.execute<{ id: string }>(sql`
    SELECT a.id FROM accounts a
    LEFT JOIN students s ON s.id = a.student_id LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.id = ${c.accountId} AND ((s.id IS NOT NULL AND s.status = 'Active' AND s.deleted_at IS NULL) OR (e.id IS NOT NULL AND e.active))
    FOR UPDATE OF a`);
  if (!acct.rows[0]) fail('FORBIDDEN', 'حساب شما فعال نیست.');

  const off = await tx.execute<{
    id: string;
    status: string;
    service_date: string;
    reserve_opens_at: Date | null;
    reserve_deadline: Date;
    meal_starts_at: Date;
    capacity: number;
    reserved_count: number;
    cafeteria_id: string;
  }>(sql`
    SELECT id, status, service_date, reserve_opens_at, reserve_deadline, meal_starts_at, capacity, reserved_count, cafeteria_id FROM meal_offerings WHERE id = ${offeringId} FOR UPDATE`);
  const o = off.rows[0];
  if (!o || o.status !== 'Published') fail('NOT_FOUND', 'این وعده برای رزرو در دسترس نیست.');
  if (o.service_date < tehranDate(now) || toDate(o.meal_starts_at) <= now) fail('BAD_REQUEST', 'زمان این وعده گذشته است.');
  if (o.reserve_opens_at && toDate(o.reserve_opens_at) > now) fail('BAD_REQUEST', 'رزرو این وعده هنوز باز نشده است.');
  if (toDate(o.reserve_deadline) <= now) fail('BAD_REQUEST', 'مهلت رزرو این وعده به پایان رسیده است.');

  const pr = await tx.execute<{ price_rial: bigint }>(
    sql`SELECT price_rial FROM offering_prices WHERE offering_id = ${offeringId} AND customer_group = ${c.group}`,
  );
  if (!pr.rows[0]) fail('NOT_FOUND', 'این وعده برای گروه شما در دسترس نیست.');
  const price = pr.rows[0].price_rial;

  const cap = await tx.execute(
    sql`UPDATE meal_offerings SET reserved_count = reserved_count + 1, updated_at = now() WHERE id = ${offeringId} AND reserved_count < capacity RETURNING reserved_count`,
  );
  if (!cap.rows[0]) fail('CONFLICT', 'ظرفیت این وعده تکمیل شده است.');

  const code = `R-${randomCode(8)}`;
  let resId: string;
  try {
    const ins = await tx.execute<{ id: string }>(sql`
      INSERT INTO reservations (code, account_id, offering_id, customer_group, price_rial, idempotency_key, qr_token, payment_id)
      VALUES (${code}, ${c.accountId}, ${offeringId}, ${c.group}, ${price.toString()}::bigint, ${idempotencyKey}, ${randomToken(24)}, ${opts.paymentId ?? null}) RETURNING id`);
    resId = ins.rows[0]!.id;
  } catch (e) {
    if (isUniqueViolation(e, 'reservations_active_uq')) throw new AppError('CONFLICT', 'این غذا را قبلاً رزرو کرده‌اید.');
    throw e;
  }

  if (price > 0n) {
    const revenue = await systemAccountId(tx, 'meal-revenue');
    await postLedger(tx, {
      type: 'ReservationDebit',
      idempotencyKey: `res:${resId}:debit`,
      actor: c.actor,
      reason: 'کسر بابت رزرو غذا',
      reservationId: resId,
      paymentId: opts.paymentId,
      lines: [
        { accountId: c.accountId, amount: -price },
        { accountId: revenue, amount: price },
      ],
    });
  }
  await tx.execute(
    sql`INSERT INTO reservation_history (reservation_id, from_status, to_status, actor, note) VALUES (${resId}, NULL, 'Reserved', ${c.actor}, 'reserve')`,
  );
  await audit(tx, {
    actor: c.actor,
    action: 'reservation.create',
    entityType: 'Reservation',
    entityId: resId,
    data: { offeringId, price: price.toString(), cafeteriaId: o.cafeteria_id },
  });
  return { reservationId: resId, code, priceRial: price, replay: false };
}

/** Standalone reservation (wallet debit) with its own transaction; idempotent replay returns the earlier result. */
export async function reserve(db: Db, c: Customer, offeringId: string, idempotencyKey: string) {
  try {
    return await db.transaction((tx) => reserveInTx(tx, c, offeringId, idempotencyKey));
  } catch (e) {
    // a concurrent duplicate with the same idempotency key → return the committed one
    if (isUniqueViolation(e, 'reservations_idem_uq')) {
      return db.transaction((tx) => reserveInTx(tx, c, offeringId, idempotencyKey));
    }
    throw e;
  }
}
