import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { accounts, staffUsers } from './identity.js';
import { createdAt, id, updatedAt } from './base.js';

/**
 * مدل مالی: **دفتر کل دوطرفه**.
 *
 * هر رویداد مالی یک `ledger_transactions` با دو (یا چند) `ledger_entries` است و
 * مجموع `amount_rial` هر تراکنش باید صفر باشد (constraint trigger تعویق‌پذیر در
 * migration `0001`). جدول‌های دفتر کل append-only هستند: UPDATE/DELETE با trigger
 * و همچنین در سطح GRANT نقش `food_app` ممنوع است.
 *
 * `accounts.balance_rial` فقط یک کش است و با `CHECK >= 0` محافظت می‌شود؛
 * job شبانهٔ `ledger-reconcile` برابری آن با مجموع ورودی‌ها را بررسی می‌کند.
 */

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: id(),
    /** ManualCredit | ManualDebit | OnlinePayment | ReservationDebit | CancellationRefund | MealUnavailableRefund | AdminRefund | WithdrawalHold | WithdrawalPaid | WithdrawalRelease | Correction */
    type: varchar('type', { length: 40 }).notNull(),
    /**
     * کلید یکتای idempotency. تکرار آن ⇒ همان تراکنش قبلی برگردانده می‌شود
     * و هیچ اثر مالی دومی ندارد.
     */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    /** Reservation | Payment | Withdrawal | Manual | Import | System */
    referenceType: varchar('reference_type', { length: 40 }),
    referenceId: uuid('reference_id'),
    reason: text('reason').notNull(),
    /** Staff | Student | Employee | System | Gateway */
    actorType: varchar('actor_type', { length: 20 }).notNull().default('System'),
    actorId: uuid('actor_id'),
    /** کد رهگیری انسانی (نمایش در رسیدها و گزارش‌ها). */
    trackingCode: varchar('tracking_code', { length: 24 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_transactions_idempotency_key').on(t.idempotencyKey),
    uniqueIndex('ledger_transactions_tracking_code').on(t.trackingCode),
    index('ledger_transactions_created_at_idx').on(t.createdAt),
    index('ledger_transactions_reference_idx').on(t.referenceType, t.referenceId),
    check(
      'ledger_transactions_type_check',
      sql`${t.type} IN ('ManualCredit','ManualDebit','OnlinePayment','ReservationDebit','CancellationRefund','MealUnavailableRefund','AdminRefund','WithdrawalHold','WithdrawalPaid','WithdrawalRelease','Correction')`,
    ),
    check('ledger_transactions_reason_required', sql`char_length(${t.reason}) >= 5`),
    check('ledger_transactions_tracking_shape', sql`${t.trackingCode} ~ '^TX-[A-Z0-9]{8,16}$'`),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    /** حساب کاربر (دانشجو/کارمند) — یا null برای سمت سیستمی. */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    /** حساب سیستمی: MEAL_REVENUE | MANUAL_CASH | GATEWAY_CLEARING | WITHDRAWAL_ESCROW | TREASURY */
    systemAccount: varchar('system_account', { length: 30 }),
    /** مبلغ علامت‌دار (ریال). بدهکار منفی، بستانکار مثبت — از دید حساب کاربر. */
    amountRial: bigint('amount_rial', { mode: 'number' }).notNull(),
    /** موجودی حساب کاربر بلافاصله پس از این ورودی (فقط برای ردیف‌های حساب کاربر). */
    balanceAfter: bigint('balance_after', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_account_created_idx').on(t.accountId, t.createdAt),
    index('ledger_entries_transaction_idx').on(t.transactionId),
    index('ledger_entries_system_account_idx').on(t.systemAccount),
    check('ledger_entries_amount_non_zero', sql`${t.amountRial} <> 0`),
    check('ledger_entries_amount_safe_range', sql`${t.amountRial} BETWEEN -9000000000000000 AND 9000000000000000`),
    // دقیقاً یکی از دو سمت پر باشد
    check('ledger_entries_side_exclusive', sql`(${t.accountId} IS NULL) <> (${t.systemAccount} IS NULL)`),
    check(
      'ledger_entries_system_account_check',
      sql`${t.systemAccount} IS NULL OR ${t.systemAccount} IN ('MEAL_REVENUE','MANUAL_CASH','GATEWAY_CLEARING','WITHDRAWAL_ESCROW','TREASURY')`,
    ),
    // `balance_after` فقط برای حساب کاربر معنا دارد
    check('ledger_entries_balance_after_only_for_account', sql`(${t.accountId} IS NOT NULL) = (${t.balanceAfter} IS NOT NULL)`),
    check('ledger_entries_balance_after_non_negative', sql`${t.balanceAfter} IS NULL OR ${t.balanceAfter} >= 0`),
  ],
);

/** پرداخت‌های درگاه (زرین‌پال پشت Feature Flag). */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** zarinpal | sandbox */
    gateway: varchar('gateway', { length: 30 }).notNull(),
    authority: varchar('authority', { length: 120 }),
    refId: varchar('ref_id', { length: 120 }),
    amountRial: bigint('amount_rial', { mode: 'number' }).notNull(),
    /** Pending | Paid | Failed | NeedsReview */
    status: varchar('status', { length: 20 }).notNull().default('Pending'),
    callbackCount: integer('callback_count').notNull().default(0),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** کلید idempotency ثبت دفتر کل برای callback تکراری/هم‌زمان. */
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    /** فقط مسیرهای داخلی سامانه مجازند (جلوگیری از open redirect). */
    returnTo: varchar('return_to', { length: 500 }).notNull().default('/wallet'),
    lastError: varchar('last_error', { length: 200 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_authority_key').on(t.authority),
    uniqueIndex('payments_idempotency_key').on(t.idempotencyKey),
    index('payments_account_created_idx').on(t.accountId, t.createdAt),
    index('payments_status_created_idx').on(t.status, t.createdAt),
    check('payments_status_check', sql`${t.status} IN ('Pending','Paid','Failed','NeedsReview')`),
    check('payments_amount_positive', sql`${t.amountRial} > 0`),
    check('payments_gateway_check', sql`${t.gateway} IN ('zarinpal','sandbox')`),
    check('payments_return_to_internal', sql`${t.returnTo} ~ '^/[a-zA-Z0-9/_?=&.%-]*$'`),
  ],
);

/** درخواست‌های برداشت وجه از کیف پول به شبای بانکی. */
export const withdrawalRequests = pgTable(
  'withdrawal_requests',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amountRial: bigint('amount_rial', { mode: 'number' }).notNull(),
    /** شبا با AES-256-GCM رمزنگاری می‌شود؛ مقدار خام ذخیره نمی‌شود. */
    ibanEncrypted: text('iban_encrypted').notNull(),
    ibanLast4: varchar('iban_last4', { length: 4 }).notNull(),
    /** Pending | Approved | Paid | Rejected | Cancelled */
    status: varchar('status', { length: 20 }).notNull().default('Pending'),
    reviewedBy: uuid('reviewed_by').references(() => staffUsers.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    reason: text('reason'),
    /** کد رهگیری پرداخت بانکی (پس از ثبت پرداخت). */
    bankReference: varchar('bank_reference', { length: 120 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('withdrawal_requests_account_idx').on(t.accountId, t.status),
    index('withdrawal_requests_status_created_idx').on(t.status, t.createdAt),
    check('withdrawal_requests_status_check', sql`${t.status} IN ('Pending','Approved','Paid','Rejected','Cancelled')`),
    check('withdrawal_requests_amount_positive', sql`${t.amountRial} > 0`),
    check('withdrawal_requests_amount_safe_range', sql`${t.amountRial} <= 9000000000000000`),
    check('withdrawal_requests_iban_last4_shape', sql`${t.ibanLast4} ~ '^[0-9]{4}$'`),
    check('withdrawal_requests_reject_requires_reason', sql`${t.status} <> 'Rejected' OR ${t.reason} IS NOT NULL`),
    check('withdrawal_requests_paid_requires_reference', sql`${t.status} <> 'Paid' OR ${t.bankReference} IS NOT NULL`),
  ],
);

export type LedgerTransactionRow = typeof ledgerTransactions.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type WithdrawalRequestRow = typeof withdrawalRequests.$inferSelect;
