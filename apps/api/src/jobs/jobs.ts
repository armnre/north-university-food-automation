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
  };
}
