import { LEDGER_TYPE_LABELS_FA, SYSTEM_ACCOUNT_LABELS_FA } from '@food/shared';
import { fail } from '../lib/errors.js';
import type { Actor, CustomerAuth, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { postLedger, readBalance, reconcileLedger, systemAccountBalances } from './ledger.service.js';
import { assertAccountUsable, findAccountByIdentifier } from './account.service.js';
import { getSettings } from './settings.service.js';
import { rawSql } from '../db/raw.js';

/**
 * مالی: شارژ/برداشت دستی توسط امور مالی، دفتر کل و اعتبار داخلی کیف پول کاربر.
 */

export type AdjustInput = {
  actor: Actor;
  staffId: string;
  subject: 'student' | 'employee';
  identifier: string;
  direction: 'credit' | 'debit';
  amountRial: number;
  reason: string;
  idempotencyKey: string;
  ip: string;
};

/** شارژ یا برداشت دستی با دلیل الزامی، سقف تراکنش، idempotency و قفل حساب. */
export async function manualAdjust(
  deps: ServiceDeps,
  input: AdjustInput,
): Promise<{ trackingCode: string; balanceRial: number; amountRial: number; replay: boolean }> {
  const settings = await getSettings(deps);
  const amount = Math.trunc(Number(input.amountRial));
  if (!Number.isInteger(amount) || amount <= 0) fail('VALIDATION', 'مبلغ باید عدد صحیح مثبت (ریال) باشد.');
  if (amount > settings.maxManualAdjustRial) {
    fail('VALIDATION', `حداکثر مبلغ مجاز در هر تراکنش دستی ${settings.maxManualAdjustRial} ریال است.`);
  }
  if (String(input.reason ?? '').trim().length < 5) {
    fail('VALIDATION', 'دلیل تراکنش دستی الزامی است (حداقل ۵ کاراکتر).');
  }

  const holder = assertAccountUsable(await findAccountByIdentifier(deps.db, input.subject, input.identifier));
  const signed = input.direction === 'credit' ? amount : -amount;
  const idemKey = `manual:${input.staffId}:${input.idempotencyKey}`;

  const result = await deps.db.transaction(async (tx) => {
    const posted = await postLedger(tx, deps, {
      type: input.direction === 'credit' ? 'ManualCredit' : 'ManualDebit',
      idempotencyKey: idemKey,
      reason: input.reason.trim(),
      actor: input.actor,
      referenceType: 'Manual',
      referenceId: holder.accountId,
      legs: [
        { accountId: holder.accountId, amountRial: signed },
        { systemAccount: 'MANUAL_CASH', amountRial: -signed },
      ],
    });

    await writeAudit(tx, {
      actor: input.actor,
      action: `finance.manual.${input.direction}`,
      targetType: 'Account',
      targetId: holder.accountId,
      details: {
        amountRial: signed,
        reason: input.reason.trim(),
        trackingCode: posted.trackingCode,
        replay: posted.replay,
        holder: holder.identifier,
      },
      ip: input.ip,
    });

    return { trackingCode: posted.trackingCode, replay: posted.replay };
  });

  const balance = await readBalance(deps.db, holder.accountId);
  return { trackingCode: result.trackingCode, balanceRial: balance, amountRial: signed, replay: result.replay };
}

/** فهرست دفتر کل با فیلتر، جمع هر نوع، ماندهٔ حساب‌های سیستمی و مغایرت‌ها. */
export async function listLedger(
  deps: ServiceDeps,
  filters: { type?: string; search?: string; from?: string; to?: string; customerGroup?: string; offset?: number; limit?: number },
) {
  const params: unknown[] = [];
  const where: string[] = ['e.account_id IS NOT NULL'];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.type) where.push(`t.type = ${p(filters.type)}`);
  if (filters.from) where.push(`(e.created_at AT TIME ZONE 'Asia/Tehran')::date >= ${p(filters.from)}::date`);
  if (filters.to) where.push(`(e.created_at AT TIME ZONE 'Asia/Tehran')::date <= ${p(filters.to)}::date`);
  if (filters.customerGroup) where.push(`a.customer_group = ${p(filters.customerGroup)}`);
  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    where.push(
      `(t.tracking_code ILIKE ${p(like)} OR s.student_number ILIKE ${p(like)} OR e2.username ILIKE ${p(like)} OR t.reason ILIKE ${p(like)})`,
    );
  }

  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const fromClause = `FROM ledger_entries e
     JOIN ledger_transactions t ON t.id = e.transaction_id
     JOIN accounts a ON a.id = e.account_id
     LEFT JOIN students s ON s.id = a.student_id
     LEFT JOIN employees e2 ON e2.id = a.employee_id
     LEFT JOIN staff_users u ON u.id = t.actor_id`;

  const entriesResult = await deps.db.execute(
    rawSql(
      `SELECT e.id, t.tracking_code AS "trackingCode", t.type, e.amount_rial::text AS "amountRial",
              e.system_account AS "systemAccount", t.reason, e.created_at AS "createdAt",
              COALESCE(s.student_number, e2.username) AS "holderIdentifier",
              COALESCE(s.full_name, e2.full_name) AS "holderName",
              a.customer_group AS "customerGroup",
              u.full_name AS actor, e.balance_after::text AS "balanceAfter"
       ${fromClause}
       ${whereSql}
       ORDER BY e.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );

  const totalsResult = await deps.db.execute(
    rawSql(
      `SELECT t.type, COUNT(*)::int AS n, COALESCE(SUM(e.amount_rial),0)::text AS total
       ${fromClause} ${whereSql} GROUP BY t.type ORDER BY t.type`,
      params,
    ),
  );

  const recon = await reconcileLedger(deps.db);
  const systemAccounts = await systemAccountBalances(deps.db);

  const entryRows = ((entriesResult as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  const totalRows = ((totalsResult as unknown as { rows: { type: string; n: number; total: string }[] }).rows ?? []) as {
    type: string;
    n: number;
    total: string;
  }[];

  return {
    entries: entryRows.map((row) => ({
      id: String(row.id),
      trackingCode: String(row.trackingCode ?? ''),
      type: String(row.type ?? ''),
      amountRial: Number(row.amountRial ?? 0),
      systemAccount: row.systemAccount == null ? null : String(row.systemAccount),
      reason: String(row.reason ?? ''),
      createdAt: new Date(String(row.createdAt)).toISOString(),
      holderIdentifier: String(row.holderIdentifier ?? ''),
      holderName: String(row.holderName ?? ''),
      customerGroup: String(row.customerGroup ?? ''),
      actor: row.actor == null ? null : String(row.actor),
      balanceAfter: row.balanceAfter == null ? null : Number(row.balanceAfter),
    })),
    totals: totalRows.map((row) => ({ type: row.type, count: Number(row.n), total: Number(row.total) })),
    systemAccounts: systemAccounts.map((row) => ({
      account: row.account,
      label: SYSTEM_ACCOUNT_LABELS_FA[row.account] ?? row.account,
      balanceRial: row.balanceRial,
    })),
    mismatches: [
      ...recon.unbalancedTransactions.map((row) => ({
        kind: 'unbalanced_transaction',
        reference: row.transactionId,
        expected: 0,
        actual: row.total,
      })),
      ...recon.balanceMismatches.map((row) => ({
        kind: 'balance_mismatch',
        reference: row.accountId,
        expected: row.ledger,
        actual: row.cached,
      })),
    ],
    hasMore: entryRows.length === limit,
  };
}

/** کیف پول کاربر جاری (موجودی اعتبار داخلی + تاریخچهٔ تراکنش‌های دفتر کل). */
export async function myWallet(deps: ServiceDeps, auth: CustomerAuth) {
  const settings = await getSettings(deps);
  const rows = await deps.db.execute(
    rawSql(
      `SELECT e.id, t.tracking_code AS "trackingCode", t.type, e.amount_rial::text AS "amountRial",
              t.reason, e.created_at AS "createdAt", e.balance_after::text AS "balanceAfter"
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE e.account_id = $1
       ORDER BY e.created_at DESC
       LIMIT 500`,
      [auth.accountId],
    ),
  );
  const entries = (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    trackingCode: String(row.trackingCode ?? ''),
    type: String(row.type ?? ''),
    typeLabel: LEDGER_TYPE_LABELS_FA[String(row.type ?? '')] ?? String(row.type ?? ''),
    amountRial: Number(row.amountRial ?? 0),
    reason: String(row.reason ?? ''),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    balanceAfter: Number(row.balanceAfter ?? 0),
  }));

  return {
    balanceRial: auth.balanceRial,
    customerGroup: auth.customerGroup,
    onlinePaymentEnabled: settings.onlinePaymentEnabled,
    transactions: entries,
  };
}
