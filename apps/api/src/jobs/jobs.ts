import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { PaymentGateway } from '../services/gateway.js';
import { settlePayment } from '../services/payments.js';
import { audit } from '../services/audit.js';

/**
 * Finalises Pending gateway payments older than `olderThanMin` whose callback never arrived
 * (user closed the browser). Uses the same idempotent settlePayment as the callback, so a late
 * callback or a second run creates nothing twice. Network errors leave the row Pending for the next run.
 */
export async function reconcilePendingPayments(db: Db, gw: PaymentGateway | null, olderThanMin = 10) {
  if (!gw) return { skipped: 'online payment disabled' };
  const rows = (
    await db.execute<{ id: string; authority: string | null; age_min: number }>(
      sql`SELECT id, authority, EXTRACT(EPOCH FROM now()-created_at)/60 AS age_min FROM payments
          WHERE status='Pending' AND created_at < now() - make_interval(mins => ${olderThanMin}) ORDER BY created_at LIMIT 200`,
    )
  ).rows;
  const out = { checked: rows.length, paid: 0, failed: 0, review: 0, retry: 0, abandoned: 0 };
  for (const r of rows) {
    if (!r.authority) {
      // Never reached the gateway: no money can have moved.
      if (r.age_min > 60) {
        await db.execute(
          sql`UPDATE payments SET status='Failed', review_note='no authority (gateway request never completed)', updated_at=now() WHERE id=${r.id} AND status='Pending'`,
        );
        out.abandoned++;
      }
      continue;
    }
    try {
      const s = await settlePayment(db, gw, r.id, null);
      if (s.status === 'Paid') out.paid++;
      else if (s.status === 'Failed') out.failed++;
      else if (s.status === 'NeedsReview') {
        out.review++;
        await audit(db, { actor: 'system', action: 'alert.payment-needs-review', entityType: 'Payment', entityId: r.id, data: { source: 'reconcile-job' } });
      }
    } catch {
      out.retry++;
    }
  }
  return out;
}

/** Nightly: every account balance must equal the sum of its entries; every transaction must sum to zero. */
export async function reconcileLedger(db: Db) {
  const badAccounts = (
    await db.execute<{ id: string }>(
      sql`SELECT a.id FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id, a.balance_rial HAVING a.balance_rial <> COALESCE(sum(e.amount_rial),0) LIMIT 50`,
    )
  ).rows;
  const badTx = (
    await db.execute<{ id: string }>(sql`SELECT transaction_id AS id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_rial) <> 0 LIMIT 50`)
  ).rows;
  if (badAccounts.length || badTx.length)
    await audit(db, {
      actor: 'system',
      action: 'alert.ledger-mismatch',
      entityType: 'Ledger',
      data: { accounts: badAccounts.map((x) => x.id), transactions: badTx.map((x) => x.id) },
    });
  return { badAccounts: badAccounts.length, badTransactions: badTx.length };
}

/** Nightly housekeeping. Never touches ledger, audit or reservations. */
export async function cleanup(db: Db) {
  const n = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rowCount ?? 0;
  return {
    sessions: await n(sql`DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR absolute_expires_at < now()`),
    loginAttempts: await n(sql`DELETE FROM login_attempts WHERE created_at < now() - interval '30 days'`),
    captchas: await n(sql`DELETE FROM captchas WHERE expires_at < now() - interval '1 hour'`),
    importRows: await n(sql`DELETE FROM import_rows WHERE created_at < now() - interval '7 days'`),
    outbox: await n(sql`DELETE FROM notification_outbox WHERE sent_at < now() - interval '30 days'`),
  };
}

/** Reservations still 'Reserved' 30 minutes after the meal window closed become NoShow (no refund). */
export async function markNoShow(db: Db, graceMin = 30) {
  const r = await db.execute<{ id: string }>(sql`
    WITH x AS (
      UPDATE reservations r SET status='NoShow', updated_at=now()
      FROM meal_offerings o
      WHERE o.id=r.offering_id AND r.status='Reserved' AND o.meal_ends_at < now() - make_interval(mins => ${graceMin})
      RETURNING r.id)
    INSERT INTO reservation_history (reservation_id, from_status, to_status, actor, note)
    SELECT id, 'Reserved', 'NoShow', 'system', 'auto: meal window closed' FROM x RETURNING reservation_id AS id`);
  return { markedNoShow: r.rows.length };
}

/** Queues one reminder per reservation for meals starting in the next 30–90 minutes. Idempotent via reservation_reminders. */
export async function sendMealReminders(db: Db) {
  const rows = (
    await db.execute<{ id: string; account_id: string; mobile: string | null; title: string; food: string; starts: string }>(sql`
      SELECT r.id, r.account_id, COALESCE(st.mobile, em.mobile) AS mobile, ms.title, f.name AS food,
             to_char(o.meal_starts_at AT TIME ZONE 'Asia/Tehran','HH24:MI') AS starts
      FROM reservations r JOIN meal_offerings o ON o.id=r.offering_id
      JOIN meal_slots ms ON ms.id=o.meal_slot_id JOIN foods f ON f.id=o.food_id
      JOIN accounts a ON a.id=r.account_id
      LEFT JOIN students st ON st.id=a.student_id LEFT JOIN employees em ON em.id=a.employee_id
      WHERE r.status='Reserved' AND o.meal_starts_at BETWEEN now() + interval '30 minutes' AND now() + interval '90 minutes'
        AND NOT EXISTS (SELECT 1 FROM reservation_reminders rr WHERE rr.reservation_id=r.id)
      LIMIT 2000`)
  ).rows;
  let sms = 0;
  for (const r of rows) {
    const body = `یادآوری: ${r.title} شما (${r.food}) ساعت ${r.starts} سرو می‌شود.`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO reservation_reminders (reservation_id) VALUES (${r.id})`);
      await tx.execute(sql`INSERT INTO notifications (account_id, title, body, kind) VALUES (${r.account_id}, 'یادآوری وعده غذایی', ${body}, 'reminder')`);
      if (r.mobile) {
        await tx.execute(sql`INSERT INTO notification_outbox (channel, recipient, body) VALUES ('sms', ${r.mobile}, ${body})`);
        sms++;
      }
    });
  }
  return { reminded: rows.length, smsQueued: sms };
}

/** Sends due outbox messages with exponential backoff; gives up after 6 attempts. FOR UPDATE SKIP LOCKED allows parallel workers. */
export async function drainSmsOutbox(db: Db, send: (to: string, body: string) => Promise<void>, batch = 100) {
  const out = { sent: 0, failed: 0 };
  await db.transaction(async (tx) => {
    const rows = (
      await tx.execute<{ id: string; recipient: string; body: string; attempts: number }>(sql`
        SELECT id, recipient, body, attempts FROM notification_outbox
        WHERE sent_at IS NULL AND channel='sms' AND attempts < 6 AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT ${batch} FOR UPDATE SKIP LOCKED`)
    ).rows;
    for (const m of rows) {
      try {
        await send(m.recipient, m.body);
        await tx.execute(sql`UPDATE notification_outbox SET sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=${m.id}`);
        out.sent++;
      } catch (e) {
        const wait = 2 ** m.attempts;
        await tx.execute(sql`UPDATE notification_outbox SET attempts=attempts+1, last_error=${String((e as Error).message).slice(0, 300)},
          next_attempt_at=now() + make_interval(mins => ${wait}) WHERE id=${m.id}`);
        out.failed++;
      }
    }
  });
  return out;
}
