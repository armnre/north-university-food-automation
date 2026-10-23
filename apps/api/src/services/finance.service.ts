import { sql } from 'drizzle-orm';
import { decryptText, encryptText } from '../lib/crypto.js';
import { isValidIban, LEDGER_TYPE_LABELS_FA, maskIban, normalizeIban, SYSTEM_ACCOUNT_LABELS_FA } from '@food/shared';
import { withdrawalRequests } from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import type { Actor, CustomerAuth, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';
import { postLedger, readBalance, reconcileLedger, systemAccountBalances } from './ledger.service.js';
import { assertAccountUsable, findAccountByIdentifier, getAccountHolder } from './account.service.js';
import { getSettings } from './settings.service.js';
import { createNotification } from './notification.service.js';
import { rawSql } from '../db/raw.js';

/**
 * مالی: شارژ/برداشت دستی توسط امور مالی، دفتر کل، کیف پول کاربر و برداشت وجه.
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

/** کیف پول کاربر جاری (موجودی + تاریخچه). */
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

  const held = await deps.db.execute(
    rawSql(
      `SELECT COALESCE(SUM(amount_rial),0)::text AS total FROM withdrawal_requests WHERE account_id = $1 AND status IN ('Pending','Approved')`,
      [auth.accountId],
    ),
  );

  return {
    balanceRial: auth.balanceRial,
    customerGroup: auth.customerGroup,
    onlinePaymentEnabled: settings.onlinePaymentEnabled,
    withdrawalEnabled: settings.withdrawalEnabled,
    minTopupRial: settings.minTopupRial,
    maxTopupRial: settings.maxTopupRial,
    heldRial: Number(((held as unknown as { rows: { total: string }[] }).rows ?? [])[0]?.total ?? '0'),
    transactions: entries,
  };
}

// ---------------------------------------------------------------------------
// برداشت وجه
// ---------------------------------------------------------------------------

export async function createWithdrawal(
  deps: ServiceDeps,
  input: { auth: CustomerAuth; amountRial: number; iban: string; ip: string },
): Promise<{ id: string; amountRial: number; status: string; ibanMasked: string }> {
  const settings = await getSettings(deps);
  if (!settings.withdrawalEnabled) {
    throw new AppError('PAYMENT_GATEWAY_DISABLED', 'برداشت وجه در حال حاضر فعال نیست. برای دریافت موجودی به امور مالی مراجعه کنید.');
  }
  const amount = Math.trunc(Number(input.amountRial));
  if (!Number.isInteger(amount) || amount <= 0) fail('VALIDATION', 'مبلغ برداشت نامعتبر است.');

  const iban = normalizeIban(input.iban);
  if (!isValidIban(iban)) fail('VALIDATION', 'شمارهٔ شبا معتبر نیست. شبا باید با IR شروع شده و ۲۶ کاراکتر باشد.');

  const holder = assertAccountUsable(await getAccountHolder(deps.db, input.auth.accountId));
  if (amount > holder.balanceRial) {
    throw new AppError('INSUFFICIENT_BALANCE', `مبلغ برداشت از موجودی کیف پول شما بیشتر است.`, { balanceRial: holder.balanceRial });
  }

  const actor: Actor =
    input.auth.kind === 'student'
      ? { type: 'Student', id: input.auth.studentId, label: input.auth.studentNumber }
      : { type: 'Employee', id: input.auth.employeeId, label: input.auth.username };

  return deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(withdrawalRequests)
      .values({
        accountId: holder.accountId,
        amountRial: amount,
        ibanEncrypted: encryptText(iban, deps.env.DATA_ENCRYPTION_KEY),
        ibanLast4: iban.slice(-4),
        status: 'Pending',
      })
      .returning({ id: withdrawalRequests.id });

    // مبلغ فوراً به حساب امانی منتقل می‌شود (مسدودی)
    await postLedger(tx, deps, {
      type: 'WithdrawalHold',
      idempotencyKey: `withdrawal-hold:${created!.id}`,
      reason: 'مسدودی موجودی بابت درخواست برداشت وجه',
      actor,
      referenceType: 'Withdrawal',
      referenceId: created!.id,
      legs: [
        { accountId: holder.accountId, amountRial: -amount },
        { systemAccount: 'WITHDRAWAL_ESCROW', amountRial: amount },
      ],
    });

    await writeAudit(tx, {
      actor,
      action: 'withdrawal.create',
      targetType: 'Withdrawal',
      targetId: created!.id,
      details: { amountRial: amount, ibanLast4: iban.slice(-4) },
      ip: input.ip,
    });

    await createNotification(tx, {
      title: 'درخواست برداشت ثبت شد',
      body: `درخواست برداشت ${amount / 10} تومان ثبت و در انتظار بررسی امور مالی است.`,
      audience: 'Account',
      accountId: holder.accountId,
      event: 'withdrawal.status',
    });

    return { id: created!.id, amountRial: amount, status: 'Pending', ibanMasked: maskIban(iban) };
  });
}

export async function listWithdrawals(
  deps: ServiceDeps,
  filters: { status?: string; accountId?: string; offset?: number; limit?: number },
) {
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filters.status) where.push(`w.status = ${p(filters.status)}`);
  if (filters.accountId) where.push(`w.account_id = ${p(filters.accountId)}::uuid`);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const rows = await deps.db.execute(
    rawSql(
      `SELECT w.id, w.amount_rial::text AS "amountRial", w.iban_last4 AS "ibanLast4", w.status, w.created_at AS "createdAt",
              w.reviewed_at AS "reviewedAt", w.paid_at AS "paidAt", w.reason, w.bank_reference AS "bankReference",
              COALESCE(s.student_number, e.username) AS "holderIdentifier", COALESCE(s.full_name, e.full_name) AS "holderName"
       FROM withdrawal_requests w
       JOIN accounts a ON a.id = w.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY w.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );
  return (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    amountRial: Number(row.amountRial ?? 0),
    ibanMasked: maskStoredIban(String(row.ibanLast4 ?? '')),
    status: String(row.status ?? ''),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    reviewedAt: row.reviewedAt ? new Date(String(row.reviewedAt)).toISOString() : null,
    paidAt: row.paidAt ? new Date(String(row.paidAt)).toISOString() : null,
    reason: row.reason == null ? null : String(row.reason),
    bankReference: row.bankReference == null ? null : String(row.bankReference),
    holderIdentifier: row.holderIdentifier == null ? null : String(row.holderIdentifier),
    holderName: row.holderName == null ? null : String(row.holderName),
  }));
}

/**
 * بررسی درخواست برداشت توسط امور مالی.
 *
 *  - `approve` : Pending → Approved
 *  - `reject`  : Pending/Approved → Rejected + آزادسازی مسدودی به کیف پول
 *  - `markPaid`: Approved → Paid + ثبت پرداخت از حساب امانی
 *
 * تأیید/رد همزمان و دوباره با قفل ردیف و انتقال وضعیت شرط‌دار کنترل می‌شود.
 */
export async function reviewWithdrawal(
  deps: ServiceDeps,
  input: {
    id: string;
    action: 'approve' | 'reject' | 'markPaid';
    reason?: string;
    bankReference?: string;
    actor: Actor;
    staffId: string;
    ip: string;
  },
): Promise<{ id: string; status: string; amountRial: number }> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx.execute(rawSql(`SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE`, [input.id]));
    const row = ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
    if (!row) fail('NOT_FOUND', 'درخواست برداشت یافت نشد.');

    const status = String(row.status);
    const amount = Number(String(row.amount_rial ?? '0'));
    const accountId = String(row.account_id);

    if (input.action === 'approve') {
      if (status !== 'Pending') fail('CONFLICT', `این درخواست پیش‌تر بررسی شده است (وضعیت فعلی: ${status}).`);
      await tx
        .update(withdrawalRequests)
        .set({ status: 'Approved', reviewedBy: input.staffId, reviewedAt: new Date() })
        .where(sql`${withdrawalRequests.id} = ${input.id} AND ${withdrawalRequests.status} = 'Pending'`);
      await notifyWithdrawal(
        tx,
        accountId,
        'درخواست برداشت شما تأیید شد',
        `درخواست برداشت ${amount / 10} تومان تأیید شد و در نوبت پرداخت است.`,
      );
      await writeAudit(tx, {
        actor: input.actor,
        action: 'withdrawal.approve',
        targetType: 'Withdrawal',
        targetId: input.id,
        details: { amountRial: amount },
        ip: input.ip,
      });
      return { id: input.id, status: 'Approved', amountRial: amount };
    }

    if (input.action === 'reject') {
      if (status !== 'Pending' && status !== 'Approved') fail('CONFLICT', `این درخواست قابل رد کردن نیست (وضعیت فعلی: ${status}).`);
      if (!input.reason || input.reason.trim().length < 5) fail('VALIDATION', 'دلیل رد کردن درخواست الزامی است.');
      await tx
        .update(withdrawalRequests)
        .set({ status: 'Rejected', reviewedBy: input.staffId, reviewedAt: new Date(), reason: input.reason.trim() })
        .where(sql`${withdrawalRequests.id} = ${input.id} AND ${withdrawalRequests.status} IN ('Pending','Approved')`);

      // آزادسازی مسدودی به کیف پول
      await postLedger(tx, deps, {
        type: 'WithdrawalRelease',
        idempotencyKey: `withdrawal-release:${input.id}`,
        reason: 'آزادسازی مسدودی بابت رد درخواست برداشت',
        actor: input.actor,
        referenceType: 'Withdrawal',
        referenceId: input.id,
        legs: [
          { accountId, amountRial: amount },
          { systemAccount: 'WITHDRAWAL_ESCROW', amountRial: -amount },
        ],
      });
      await notifyWithdrawal(
        tx,
        accountId,
        'درخواست برداشت رد شد',
        `درخواست برداشت ${amount / 10} تومان به دلیل «${input.reason.trim()}» رد شد و مبلغ به کیف پول شما بازگشت.`,
      );
      await writeAudit(tx, {
        actor: input.actor,
        action: 'withdrawal.reject',
        targetType: 'Withdrawal',
        targetId: input.id,
        details: { amountRial: amount, reason: input.reason.trim() },
        ip: input.ip,
      });
      return { id: input.id, status: 'Rejected', amountRial: amount };
    }

    // markPaid
    if (status !== 'Approved') fail('CONFLICT', `فقط درخواست تأییدشده قابل ثبت پرداخت است (وضعیت فعلی: ${status}).`);
    const reference = String(input.bankReference ?? '').trim();
    if (!reference) fail('VALIDATION', 'ثبت کد رهگیری پرداخت بانکی الزامی است.');
    await tx
      .update(withdrawalRequests)
      .set({ status: 'Paid', paidAt: new Date(), bankReference: reference.slice(0, 120) })
      .where(sql`${withdrawalRequests.id} = ${input.id} AND ${withdrawalRequests.status} = 'Approved'`);

    await postLedger(tx, deps, {
      type: 'WithdrawalPaid',
      idempotencyKey: `withdrawal-paid:${input.id}`,
      reason: `پرداخت برداشت وجه (کد رهگیری ${reference.slice(0, 40)})`,
      actor: input.actor,
      referenceType: 'Withdrawal',
      referenceId: input.id,
      legs: [
        { systemAccount: 'WITHDRAWAL_ESCROW', amountRial: -amount },
        { systemAccount: 'TREASURY', amountRial: amount },
      ],
    });
    await notifyWithdrawal(
      tx,
      accountId,
      'برداشت وجه پرداخت شد',
      `مبلغ ${amount / 10} تومان به حساب بانکی شما واریز شد. کد رهگیری: ${reference}`,
    );
    await writeAudit(tx, {
      actor: input.actor,
      action: 'withdrawal.paid',
      targetType: 'Withdrawal',
      targetId: input.id,
      details: { amountRial: amount, bankReference: reference },
      ip: input.ip,
    });
    return { id: input.id, status: 'Paid', amountRial: amount };
  });
}

async function notifyWithdrawal(target: Tx, accountId: string, title: string, body: string): Promise<void> {
  await createNotification(target, { title, body, audience: 'Account', accountId, event: 'withdrawal.status' });
}

/** شبا فقط برای امور مالی، آن هم ماسک‌شده، قابل مشاهده است. */
export async function revealIbanForFinance(deps: ServiceDeps, id: string): Promise<string> {
  const rows = await deps.db
    .select({ ibanEncrypted: withdrawalRequests.ibanEncrypted, ibanLast4: withdrawalRequests.ibanLast4 })
    .from(withdrawalRequests)
    .where(sql`${withdrawalRequests.id} = ${id}`)
    .limit(1);
  const row = rows[0];
  if (!row) fail('NOT_FOUND', 'درخواست برداشت یافت نشد.');
  try {
    return maskIban(decryptText(row.ibanEncrypted, deps.env.DATA_ENCRYPTION_KEY));
  } catch {
    return maskIban(`IR${row.ibanLast4}`);
  }
}

/** نمایش ماسک‌شدهٔ شبا وقتی فقط ۴ رقم آخر ذخیره شده است. */
function maskStoredIban(last4: string): string {
  const digits = String(last4 ?? '')
    .replace(/\D/g, '')
    .slice(-4);
  return `IR${'•'.repeat(22)}${digits || '••••'}`;
}
