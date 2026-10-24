import { eq, inArray, sql } from 'drizzle-orm';
import type { LedgerTxType, SystemAccount } from '@food/shared';
import { accounts, ledgerEntries, ledgerTransactions } from '../db/schema/index.js';
import { rawSql } from '../db/raw.js';
import { newTrackingCode } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { Actor, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';

/**
 * دفتر کل دوطرفه.
 *
 * قوانین:
 *  - هر تراکنش حداقل دو ورودی دارد و مجموع `amount_rial` آن صفر است
 *    (در کد بررسی می‌شود و در دیتابیس با constraint trigger تعویق‌پذیر).
 *  - ورودی حساب کاربر: قفل ردیف `FOR UPDATE`، به‌روزرسانی موجودی با شرط
 *    «منفی نشود» و ثبت `balance_after`.
 *  - `idempotency_key` یکتا: تکرار ⇒ همان تراکنش قبلی بدون اثر دوم.
 *  - جدول‌های دفتر کل append-only هستند (trigger + REVOKE).
 */

export type LedgerLeg =
  | { accountId: string; systemAccount?: never; amountRial: number }
  | { systemAccount: SystemAccount; accountId?: never; amountRial: number };

export type LedgerPostInput = {
  type: LedgerTxType;
  idempotencyKey: string;
  reason: string;
  actor: Actor;
  referenceType?: string;
  referenceId?: string | null;
  legs: LedgerLeg[];
  /** اگر فراخواننده همین تراکنش قبلاً ردیف‌های `accounts` را با `FOR UPDATE` قفل کرده باشد، از قفل تکراری پرهیز می‌شود. */
  prelockedAccounts?: Map<string, AccountLock>;
  /** رویداد ممیزی همراه (اختیاری) — داخل همان تراکنش ثبت می‌شود. */
  audit?: { action: string; targetType: string; targetId?: string | null; details?: Record<string, unknown> };
};

export type LedgerPostResult = {
  transactionId: string;
  trackingCode: string;
  replay: boolean;
  balances: Record<string, number>;
};

type AccountLock = { id: string; balanceRial: number; isActive: boolean };

/** قفل و خواندن حساب‌های کاربر در یک تراکنش (برای جلوگیری از شرط رقابت). */
export async function lockAccountsForUpdate(target: Tx, accountIds: string[]): Promise<Map<string, AccountLock>> {
  const map = new Map<string, AccountLock>();
  if (accountIds.length === 0) return map;
  const rows = await target
    .select({ id: accounts.id, balanceRial: accounts.balanceRial, isActive: accounts.isActive })
    .from(accounts)
    .where(inArray(accounts.id, accountIds))
    .orderBy(accounts.id)
    .for('update');
  for (const row of rows) {
    map.set(row.id, { id: row.id, balanceRial: Number(row.balanceRial), isActive: Boolean(row.isActive) });
  }
  return map;
}

/**
 * ثبت یک تراکنش دوطرفه.
 * باید داخل یک تراکنش PostgreSQL فراخوانی شود (`target` یک `Tx` است).
 */
export async function postLedger(target: Tx, deps: ServiceDeps, input: LedgerPostInput): Promise<LedgerPostResult> {
  const legs = input.legs.filter((leg) => Number(leg.amountRial) !== 0);
  if (legs.length < 2) {
    throw new AppError('VALIDATION', 'تراکنش مالی باید حداقل دو طرف (بدهکار و بستانکار) داشته باشد.');
  }
  const total = legs.reduce((acc, leg) => acc + Number(leg.amountRial), 0);
  if (total !== 0) {
    throw new AppError('VALIDATION', 'تراکنش مالی تراز نیست (مجموع طرف‌ها باید صفر باشد).');
  }
  for (const leg of legs) {
    if (!Number.isSafeInteger(Number(leg.amountRial))) {
      throw new AppError('VALIDATION', 'مبلغ باید عدد صحیح (ریال) باشد.');
    }
    if (!('accountId' in leg && leg.accountId) && !('systemAccount' in leg && leg.systemAccount)) {
      throw new AppError('VALIDATION', 'هر طرف تراکنش باید یک حساب کاربر یا یک حساب سیستمی باشد.');
    }
  }
  if (String(input.reason ?? '').trim().length < 5) {
    throw new AppError('VALIDATION', 'دلیل تراکنش مالی الزامی است (حداقل ۵ کاراکتر).');
  }

  // idempotency: اگر قبلاً ثبت شده، همان نتیجه برگردانده می‌شود
  const existing = await target
    .select({ id: ledgerTransactions.id, trackingCode: ledgerTransactions.trackingCode })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing[0]) {
    return { transactionId: existing[0].id, trackingCode: existing[0].trackingCode, replay: true, balances: {} };
  }

  const accountIds = [
    ...new Set(legs.filter((l) => 'accountId' in l && l.accountId).map((l) => String((l as { accountId: string }).accountId))),
  ];
  const needsLock = accountIds.some((id) => !input.prelockedAccounts?.has(id));
  const locked = needsLock ? await lockAccountsForUpdate(target, accountIds) : input.prelockedAccounts!;

  for (const id of accountIds) {
    if (!locked.has(id)) throw new AppError('NOT_FOUND', 'حساب کیف پول یافت نشد.');
    if (!locked.get(id)!.isActive) throw new AppError('ACCOUNT_INACTIVE', 'حساب کیف پول غیرفعال است.');
  }

  // مسیر سریع تک‌دور (CTE) برای حالت استاندارد دوطرفه (یک حساب کاربر + یک حساب سیستمی، بدون audit جانبی)
  const accLeg =
    legs.length === 2
      ? legs.find((l): l is { accountId: string; amountRial: number } => 'accountId' in l && Boolean(l.accountId))
      : undefined;
  const sysLeg =
    legs.length === 2
      ? legs.find((l): l is { systemAccount: SystemAccount; amountRial: number } => 'systemAccount' in l && Boolean(l.systemAccount))
      : undefined;
  if (accLeg && sysLeg && !input.audit) {
    const tracking = newTrackingCode();
    const accAmount = Number(accLeg.amountRial);
    const sysAmount = Number(sysLeg.amountRial);
    const cteRes = await target.execute(
      rawSql(
        `WITH upd_acc AS (
           UPDATE accounts
           SET balance_rial = balance_rial + $1::bigint
           WHERE id = $2::uuid AND is_active = true AND balance_rial + $1::bigint >= 0
           RETURNING id, balance_rial
         ),
         ins_tx AS (
           INSERT INTO ledger_transactions (type, idempotency_key, reference_type, reference_id, reason, actor_type, actor_id, tracking_code)
           SELECT $3, $4, $5, $6::uuid, $7, $8, $9::uuid, $10
           FROM upd_acc
           RETURNING id, tracking_code
         ),
         ins_entries AS (
           INSERT INTO ledger_entries (transaction_id, account_id, system_account, amount_rial, balance_after)
           SELECT ins_tx.id, upd_acc.id, NULL, $1::bigint, upd_acc.balance_rial FROM ins_tx CROSS JOIN upd_acc
           UNION ALL
           SELECT ins_tx.id, NULL, $11, $12::bigint, NULL FROM ins_tx CROSS JOIN upd_acc
         )
         SELECT ins_tx.id AS "txId", ins_tx.tracking_code AS "trackingCode", upd_acc.balance_rial::text AS "newBalance"
         FROM ins_tx CROSS JOIN upd_acc`,
        [
          accAmount,
          accLeg.accountId,
          input.type,
          input.idempotencyKey,
          input.referenceType ?? null,
          input.referenceId || null,
          input.reason.trim().slice(0, 1000),
          input.actor.type,
          input.actor.id || null,
          tracking,
          sysLeg.systemAccount,
          sysAmount,
        ],
      ),
    );
    const cteRow = ((cteRes as unknown as { rows: { txId: string; trackingCode: string; newBalance: string }[] }).rows ?? [])[0];
    if (!cteRow) {
      throw new AppError('INSUFFICIENT_BALANCE', 'موجودی کیف پول برای این عملیات کافی نیست.');
    }
    return {
      transactionId: cteRow.txId,
      trackingCode: cteRow.trackingCode,
      replay: false,
      balances: { [accLeg.accountId]: Number(cteRow.newBalance) },
    };
  }

  const [transaction] = await target
    .insert(ledgerTransactions)
    .values({
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      reason: input.reason.trim().slice(0, 1000),
      actorType: input.actor.type,
      actorId: input.actor.id || null,
      trackingCode: newTrackingCode(),
    })
    .returning({ id: ledgerTransactions.id, trackingCode: ledgerTransactions.trackingCode });

  const balances: Record<string, number> = {};
  const entryValues: (typeof ledgerEntries.$inferInsert)[] = [];

  for (const leg of legs) {
    const amount = Number(leg.amountRial);
    if ('accountId' in leg && leg.accountId) {
      const accountId = leg.accountId;
      // کسر/افزایش اتمیک با شرط «منفی نشود»
      const updated = await target
        .update(accounts)
        .set({ balanceRial: sql`${accounts.balanceRial} + ${amount}` })
        .where(sql`${accounts.id} = ${accountId} AND ${accounts.balanceRial} + ${amount} >= 0`)
        .returning({ balanceRial: accounts.balanceRial });
      if (updated.length === 0) {
        throw new AppError('INSUFFICIENT_BALANCE', 'موجودی کیف پول برای این عملیات کافی نیست.');
      }
      balances[accountId] = Number(updated[0]!.balanceRial);
      entryValues.push({
        transactionId: transaction!.id,
        accountId,
        systemAccount: null,
        amountRial: amount,
        balanceAfter: Number(updated[0]!.balanceRial),
      });
    } else {
      entryValues.push({
        transactionId: transaction!.id,
        accountId: null,
        systemAccount: (leg as { systemAccount: SystemAccount }).systemAccount,
        amountRial: amount,
        balanceAfter: null,
      });
    }
  }

  await target.insert(ledgerEntries).values(entryValues);

  if (input.audit) {
    await writeAudit(target, {
      actor: input.actor,
      action: input.audit.action,
      targetType: input.audit.targetType,
      targetId: input.audit.targetId ?? transaction!.id,
      details: { ...(input.audit.details ?? {}), trackingCode: transaction!.trackingCode, amountRial: Math.abs(legs[0]?.amountRial ?? 0) },
    });
  }

  return { transactionId: transaction!.id, trackingCode: transaction!.trackingCode, replay: false, balances };
}

/** موجودی فعلی یک حساب (از ستون کش‌شده). */
export async function readBalance(target: Tx | ServiceDeps['db'], accountId: string): Promise<number> {
  const rows = await target.select({ balanceRial: accounts.balanceRial }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return Number(rows[0]?.balanceRial ?? 0);
}

/**
 * موجودی محاسبه‌شده از دفتر کل (منبع حقیقت) — برای تطبیق.
 */
export async function ledgerBalance(target: Tx | ServiceDeps['db'], accountId: string): Promise<number> {
  const rows = await target.execute(
    sql`SELECT COALESCE(SUM(amount_rial),0)::text AS total FROM ledger_entries WHERE account_id = ${accountId}`,
  );
  return Number((rows as unknown as { rows: { total: string }[] }).rows?.[0]?.total ?? '0');
}

/** مجموع ماندهٔ هر حساب سیستمی (برای گزارش مدیر ارشد). */
export async function systemAccountBalances(target: Tx | ServiceDeps['db']): Promise<{ account: SystemAccount; balanceRial: number }[]> {
  const rows = await target.execute(
    sql`SELECT system_account AS account, COALESCE(SUM(amount_rial),0)::text AS total
        FROM ledger_entries WHERE system_account IS NOT NULL GROUP BY system_account ORDER BY system_account`,
  );
  return ((rows as unknown as { rows: { account: SystemAccount; total: string }[] }).rows ?? []).map((r) => ({
    account: r.account,
    balanceRial: Number(r.total),
  }));
}

/**
 * تطبیق دفتر کل:
 *  - هر تراکنش باید مجموع صفر داشته باشد
 *  - موجودی کش‌شدهٔ هر حساب باید برابر مجموع ورودی‌هایش باشد
 *  - هر ورودی حساب کاربر باید `balance_after` داشته باشد
 */
export async function reconcileLedger(target: Tx | ServiceDeps['db']): Promise<{
  unbalancedTransactions: { transactionId: string; total: number }[];
  balanceMismatches: { accountId: string; cached: number; ledger: number }[];
  checkedAccounts: number;
  checkedTransactions: number;
}> {
  const unbalanced = await target.execute(
    sql`SELECT transaction_id AS "transactionId", SUM(amount_rial)::text AS total
        FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_rial) <> 0 LIMIT 200`,
  );
  const mismatches = await target.execute(
    sql`SELECT a.id AS "accountId", a.balance_rial::text AS cached,
               COALESCE((SELECT SUM(e.amount_rial) FROM ledger_entries e WHERE e.account_id = a.id),0)::text AS ledger
        FROM accounts a
        WHERE a.balance_rial <> COALESCE((SELECT SUM(e.amount_rial) FROM ledger_entries e WHERE e.account_id = a.id),0)
        LIMIT 200`,
  );
  const counts = await target.execute(
    sql`SELECT (SELECT COUNT(*) FROM accounts)::int AS accounts, (SELECT COUNT(*) FROM ledger_transactions)::int AS transactions`,
  );

  const toRows = <T>(result: unknown): T[] => (result as { rows?: T[] }).rows ?? [];
  const countRow = toRows<{ accounts: number; transactions: number }>(counts)[0];

  return {
    unbalancedTransactions: toRows<{ transactionId: string; total: string }>(unbalanced).map((r) => ({
      transactionId: r.transactionId,
      total: Number(r.total),
    })),
    balanceMismatches: toRows<{ accountId: string; cached: string; ledger: string }>(mismatches).map((r) => ({
      accountId: r.accountId,
      cached: Number(r.cached),
      ledger: Number(r.ledger),
    })),
    checkedAccounts: Number(countRow?.accounts ?? 0),
    checkedTransactions: Number(countRow?.transactions ?? 0),
  };
}
