import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { accounts, staffUsers } from './identity.js';
import { createdAt, id, updatedAt } from './base.js';

/** بخش سیستمی: ممیزی، واردسازی، اعلان‌ها، تنظیمات و اجرای jobها. */

/**
 * لاگ ممیزی — **append-only**.
 * UPDATE/DELETE هم با trigger و هم با REVOKE روی نقش `food_app` ممنوع است.
 * هیچ دادهٔ حساسی (کد ملی خام، رمز، شبا، توکن) در `details` نوشته نمی‌شود.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    /** Staff | Student | Employee | System | Anonymous | Gateway */
    actorType: varchar('actor_type', { length: 20 }).notNull(),
    actorId: uuid('actor_id'),
    actorLabel: varchar('actor_label', { length: 160 }).notNull().default(''),
    action: varchar('action', { length: 80 }).notNull(),
    targetType: varchar('target_type', { length: 60 }).notNull().default(''),
    targetId: varchar('target_id', { length: 64 }).notNull().default(''),
    details: jsonb('details'),
    ip: varchar('ip', { length: 64 }).notNull().default(''),
    userAgent: varchar('user_agent', { length: 300 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_created_at_idx').on(t.createdAt),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
    index('audit_logs_actor_idx').on(t.actorType, t.actorId),
    index('audit_logs_action_idx').on(t.action),
    check('audit_logs_actor_type_check', sql`${t.actorType} IN ('Staff','Student','Employee','System','Anonymous','Gateway')`),
  ],
);

/** دستهٔ واردسازی اکسل. دادهٔ خام فایل نگهداری نمی‌شود. */
export const importBatches = pgTable(
  'import_batches',
  {
    id: id(),
    fileName: varchar('file_name', { length: 200 }).notNull(),
    uploadedBy: uuid('uploaded_by').references(() => staffUsers.id, { onDelete: 'restrict' }),
    /** Preview | Committed | Cancelled | Failed | Undone */
    status: varchar('status', { length: 20 }).notNull().default('Preview'),
    /** RejectAllOnError | SkipInvalidRows */
    policy: varchar('policy', { length: 30 }).notNull().default('SkipInvalidRows'),
    fullSync: boolean('full_sync').notNull().default(false),
    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    errorRows: integer('error_rows').notNull().default(0),
    newRows: integer('new_rows').notNull().default(0),
    changedRows: integer('changed_rows').notNull().default(0),
    unchangedRows: integer('unchanged_rows').notNull().default(0),
    returningRows: integer('returning_rows').notNull().default(0),
    removedRows: integer('removed_rows').notNull().default(0),
    /** ردیف‌هایی که کد ملی‌شان با شمارهٔ دانشجویی موجود تعارض دارد (نیازمند تأیید صریح). */
    conflictRows: integer('conflict_rows').notNull().default(0),
    /** اثر انگشت محتوای فایل برای تشخیص آپلود تکراری. */
    fileFingerprint: varchar('file_fingerprint', { length: 64 }),
    errorReport: jsonb('error_report'),
    /** شناسهٔ ردیف‌هایی که معاونت تعارضشان را تأیید کرده است. */
    approvedConflicts: jsonb('approved_conflicts'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    committedBy: uuid('committed_by'),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: uuid('undone_by'),
    failureMessage: text('failure_message'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('import_batches_status_idx').on(t.status),
    index('import_batches_created_at_idx').on(t.createdAt),
    index('import_batches_fingerprint_idx').on(t.fileFingerprint),
    check('import_batches_status_check', sql`${t.status} IN ('Preview','Committed','Cancelled','Failed','Undone')`),
    check('import_batches_policy_check', sql`${t.policy} IN ('RejectAllOnError','SkipInvalidRows')`),
    check('import_batches_counts_non_negative', sql`${t.totalRows} >= 0 AND ${t.validRows} >= 0 AND ${t.errorRows} >= 0`),
  ],
);

/**
 * ردیف‌های مرحله‌شدهٔ واردسازی — فقط دادهٔ هش‌شده/غیرحساس.
 * کد ملی خام هرگز ذخیره نمی‌شود. پس از ۷ روز توسط job `cleanup` پاک می‌شود.
 */
export const importRows = pgTable(
  'import_rows',
  {
    id: id(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    studentNumber: varchar('student_number', { length: 20 }).notNull().default(''),
    fullName: varchar('full_name', { length: 200 }).notNull().default(''),
    faculty: varchar('faculty', { length: 200 }).notNull().default(''),
    major: varchar('major', { length: 200 }).notNull().default(''),
    degree: varchar('degree', { length: 100 }).notNull().default(''),
    entryYear: integer('entry_year'),
    nationalIdHash: varchar('national_id_hash', { length: 64 }).notNull().default(''),
    nationalIdLast4: varchar('national_id_last4', { length: 4 }).notNull().default(''),
    /** new | changed | unchanged | returning | conflict | error */
    kind: varchar('kind', { length: 20 }).notNull().default('new'),
    studentId: uuid('student_id'),
    errors: jsonb('errors'),
    changes: jsonb('changes'),
    applied: boolean('applied').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('import_rows_batch_idx').on(t.batchId, t.rowNumber),
    index('import_rows_student_number_idx').on(t.studentNumber),
    check('import_rows_kind_check', sql`${t.kind} IN ('new','changed','unchanged','returning','conflict','error')`),
    check('import_rows_no_raw_national_id', sql`${t.nationalIdHash} = '' OR char_length(${t.nationalIdHash}) = 64`),
  ],
);

/** اعلان درون‌برنامه‌ای (برای حساب دانشجو/کارمند یا کارکنان، یا عمومی). */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    /** Broadcast | Account | Staff */
    audience: varchar('audience', { length: 20 }).notNull().default('Broadcast'),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    staffUserId: uuid('staff_user_id').references(() => staffUsers.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 60 }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_account_created_idx').on(t.accountId, t.createdAt),
    index('notifications_staff_created_idx').on(t.staffUserId, t.createdAt),
    index('notifications_created_at_idx').on(t.createdAt),
    check('notifications_audience_check', sql`${t.audience} IN ('Broadcast','Account','Staff')`),
    check(
      'notifications_audience_target',
      sql`(${t.audience} = 'Broadcast' AND ${t.accountId} IS NULL AND ${t.staffUserId} IS NULL)
        OR (${t.audience} = 'Account' AND ${t.accountId} IS NOT NULL AND ${t.staffUserId} IS NULL)
        OR (${t.audience} = 'Staff' AND ${t.staffUserId} IS NOT NULL AND ${t.accountId} IS NULL)`,
    ),
  ],
);

export const notificationReads = pgTable(
  'notification_reads',
  {
    id: id(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    /** Account | Staff */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_reads_unique').on(t.notificationId, t.subjectType, t.subjectId),
    check('notification_reads_subject_check', sql`${t.subjectType} IN ('Account','Staff')`),
  ],
);

/**
 * صف ارسال پیامک. ارسال **پس از commit** تراکنش اصلی و توسط worker انجام می‌شود
 * تا هرگز پاسخ کاربر را بلوکه نکند. تلاش مجدد با backoff.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: id(),
    notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'cascade' }),
    /** شمارهٔ مقصد؛ اگر خالی باشد فقط اعلان درون‌برنامه‌ای ارسال می‌شود. */
    recipient: varchar('recipient', { length: 20 }).notNull().default(''),
    accountId: uuid('account_id'),
    message: text('message').notNull(),
    /** Queued | Sent | Failed | Skipped */
    status: varchar('status', { length: 20 }).notNull().default('Queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: varchar('last_error', { length: 300 }),
    providerMessageId: varchar('provider_message_id', { length: 120 }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('notification_outbox_due_idx').on(t.status, t.nextAttemptAt),
    check('notification_outbox_status_check', sql`${t.status} IN ('Queued','Sent','Failed','Skipped')`),
    check('notification_outbox_attempts_bound', sql`${t.attempts} >= 0 AND ${t.attempts} <= 20`),
  ],
);

/** تنظیمات کلید/مقدار (jsonb) با ثبت چه کسی و چه زمانی تغییر داده است. */
export const systemSettings = pgTable(
  'system_settings',
  {
    key: varchar('key', { length: 60 }).primaryKey(),
    value: jsonb('value').notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  () => [],
);

/** اجرای jobهای زمان‌بندی‌شده (نمایش در صفحهٔ تنظیمات برای SuperAdmin). */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: id(),
    job: varchar('job', { length: 60 }).notNull(),
    /** Running | Ok | Failed | Skipped */
    status: varchar('status', { length: 20 }).notNull().default('Running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    message: text('message'),
    details: jsonb('details'),
    /** شناسهٔ نمونهٔ worker (برای تشخیص اجرای هم‌زمان). */
    workerId: varchar('worker_id', { length: 80 }).notNull().default(''),
  },
  (t) => [
    index('job_runs_job_started_idx').on(t.job, t.startedAt),
    check('job_runs_status_check', sql`${t.status} IN ('Running','Ok','Failed','Skipped')`),
    check('job_runs_finished_after_start', sql`${t.finishedAt} IS NULL OR ${t.finishedAt} >= ${t.startedAt}`),
  ],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type ImportBatchRow = typeof importBatches.$inferSelect;
export type ImportRowRow = typeof importRows.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type JobRunRow = typeof jobRuns.$inferSelect;
