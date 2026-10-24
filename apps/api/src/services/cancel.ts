import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { fail } from '../lib/errors.js';
import { audit } from './audit.js';
import { postLedger, systemAccountId } from './ledger.js';

/**
 * Cancels a Reserved reservation and refunds its price to the customer's wallet credit, all in the caller's tx.
 * Idempotent via ledger key `cancel:{id}` and the `status='Reserved'` guard.
 */
export async function cancelReservationInTx(
  tx: Tx,
  reservationId: string,
  actor: string,
  reason: string,
  kind: 'CancelRefund' | 'MealCancelledRefund' | 'SoldOutRefund' = 'CancelRefund',
) {
  const r = await tx.execute<{ id: string; account_id: string; offering_id: string; price_rial: bigint }>(sql`
    UPDATE reservations SET status = 'Cancelled', cancelled_at = now(), cancel_reason = ${reason}, updated_at = now()
    WHERE id = ${reservationId} AND status = 'Reserved' RETURNING id, account_id, offering_id, price_rial`);
  const row = r.rows[0];
  if (!row) fail('CONFLICT', 'این رزرو قابل لغو نیست.');
  await tx.execute(sql`UPDATE meal_offerings SET reserved_count = reserved_count - 1, updated_at = now() WHERE id = ${row.offering_id} AND reserved_count > 0`);
  if (row.price_rial > 0n) {
    const revenue = await systemAccountId(tx, 'meal-revenue');
    await postLedger(tx, {
      type: kind,
      idempotencyKey: `cancel:${row.id}`,
      actor,
      reason,
      reservationId: row.id,
      lines: [
        { accountId: revenue, amount: -row.price_rial },
        { accountId: row.account_id, amount: row.price_rial },
      ],
    });
  }
  await tx.execute(
    sql`INSERT INTO reservation_history (reservation_id, from_status, to_status, actor, note) VALUES (${row.id}, 'Reserved', 'Cancelled', ${actor}, ${reason})`,
  );
  await audit(tx, {
    actor,
    action: 'reservation.cancel',
    entityType: 'Reservation',
    entityId: row.id,
    data: { reason, refund: row.price_rial.toString(), kind },
  });
  return { accountId: row.account_id, refund: row.price_rial };
}
