import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { fail } from '../lib/errors.js';
import { trackingCode } from '../lib/crypto.js';

export type LedgerLine = { accountId: string; amount: bigint };
export type PostInput = {
  type: string;
  idempotencyKey: string;
  actor: string;
  reason?: string;
  reservationId?: string;
  paymentId?: string;
  lines: LedgerLine[];
};

export async function systemAccountId(tx: Tx, code: string): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE code = ${code}`);
  if (!r.rows[0]) throw new Error(`system account ${code} missing — run seed`);
  return r.rows[0].id;
}

/**
 * Posts a balanced double-entry transaction inside the caller's DB transaction.
 * - Idempotent: an existing idempotency_key returns the earlier transaction (replay=true).
 * - Customer accounts are debited atomically with `balance_rial + amt >= 0` (CHECK also enforces it).
 * - Accounts are updated in id order to avoid deadlocks; balance_after is recorded per entry.
 */
export async function postLedger(tx: Tx, p: PostInput): Promise<{ transactionId: string; trackingCode: string; replay: boolean }> {
  const sum = p.lines.reduce((s, l) => s + l.amount, 0n);
  if (sum !== 0n || p.lines.length < 2 || p.lines.some((l) => l.amount === 0n)) throw new Error('unbalanced ledger posting');
  const ins = await tx.execute<{ id: string; tracking_code: string }>(sql`
    INSERT INTO ledger_transactions (type, idempotency_key, tracking_code, reason, actor, reservation_id, payment_id)
    VALUES (${p.type}, ${p.idempotencyKey}, ${trackingCode()}, ${p.reason ?? null}, ${p.actor}, ${p.reservationId ?? null}, ${p.paymentId ?? null})
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, tracking_code`);
  if (!ins.rows[0]) {
    const prev = await tx.execute<{ id: string; tracking_code: string }>(
      sql`SELECT id, tracking_code FROM ledger_transactions WHERE idempotency_key = ${p.idempotencyKey}`,
    );
    return { transactionId: prev.rows[0]!.id, trackingCode: prev.rows[0]!.tracking_code, replay: true };
  }
  const txId = ins.rows[0].id;
  for (const l of [...p.lines].sort((a, b) => a.accountId.localeCompare(b.accountId))) {
    const u = await tx.execute<{ balance_rial: bigint }>(sql`
      UPDATE accounts SET balance_rial = balance_rial + ${l.amount.toString()}::bigint, updated_at = now()
      WHERE id = ${l.accountId} AND (kind = 'System' OR balance_rial + ${l.amount.toString()}::bigint >= 0)
      RETURNING balance_rial`);
    if (!u.rows[0]) fail('PAYMENT_REQUIRED', 'موجودی کیف پول کافی نیست.');
    await tx.execute(
      sql`INSERT INTO ledger_entries (transaction_id, account_id, amount_rial, balance_after) VALUES (${txId}, ${l.accountId}, ${l.amount.toString()}::bigint, ${u.rows[0].balance_rial.toString()}::bigint)`,
    );
  }
  return { transactionId: txId, trackingCode: ins.rows[0].tracking_code, replay: false };
}
