import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
const rial = (name: string) => bigint(name, { mode: 'bigint' });

export const studentStatus = pgEnum('student_status', ['Active', 'OnLeave', 'Withdrawn', 'Graduated', 'Removed']);
export const staffRole = pgEnum('staff_role', ['SuperAdmin', 'StudentAffairs', 'NutritionManager', 'Finance', 'Contractor', 'Operator']);
export const customerGroup = pgEnum('customer_group', ['Student', 'Employee']);
export const employeeKind = pgEnum('employee_kind', ['Staff', 'Faculty', 'Contractor']);
export const accountKind = pgEnum('account_kind', ['Customer', 'System']);
export const offeringStatus = pgEnum('offering_status', ['Draft', 'Published', 'SoldOut', 'Cancelled']);
export const reservationStatus = pgEnum('reservation_status', ['Reserved', 'Delivered', 'Cancelled', 'NoShow', 'Rejected']);
export const deliveryOutcome = pgEnum('delivery_outcome', [
  'Accepted',
  'AlreadyDelivered',
  'WrongCafeteria',
  'OutOfWindow',
  'NotFound',
  'Cancelled',
  'OfflineConflict',
]);
export const paymentStatus = pgEnum('payment_status', ['Pending', 'Paid', 'Failed', 'NeedsReview']);
export const importStatus = pgEnum('import_status', ['Previewed', 'Committing', 'Committed', 'Cancelled', 'Undone']);

// ── identity ────────────────────────────────────────────────────────────────
export const students = pgTable(
  'students',
  {
    id: id(),
    studentNumber: text('student_number').notNull(),
    nationalIdHash: text('national_id_hash').notNull(),
    nationalIdLast4: text('national_id_last4').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    faculty: text('faculty'),
    major: text('major'),
    degree: text('degree'),
    entryYear: smallint('entry_year'),
    mobile: text('mobile'),
    status: studentStatus('status').notNull().default('Active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastImportBatchId: uuid('last_import_batch_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...ts(),
  },
  (t) => [
    uniqueIndex('students_student_number_uq').on(t.studentNumber),
    uniqueIndex('students_national_id_hash_uq').on(t.nationalIdHash),
    check('students_last4_ck', sql`${t.nationalIdLast4} ~ '^[0-9]{4}$'`),
  ],
);

export const employees = pgTable(
  'employees',
  {
    id: id(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    kind: employeeKind('kind').notNull().default('Staff'),
    personnelCode: text('personnel_code'),
    mobile: text('mobile'),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    ...ts(),
  },
  (t) => [uniqueIndex('employees_username_uq').on(sql`lower(${t.username})`)],
);

export const contractors = pgTable('contractors', {
  id: id(),
  name: text('name').notNull(),
  contractNumber: text('contract_number'),
  contactPhone: text('contact_phone'),
  active: boolean('active').notNull().default(true),
  ...ts(),
});

export const cafeterias = pgTable(
  'cafeterias',
  {
    id: id(),
    name: text('name').notNull(),
    location: text('location'),
    contractorId: uuid('contractor_id').references(() => contractors.id),
    active: boolean('active').notNull().default(true),
    ...ts(),
  },
  (t) => [index('cafeterias_contractor_idx').on(t.contractorId)],
);

export const staffUsers = pgTable(
  'staff_users',
  {
    id: id(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    fullName: text('full_name').notNull(),
    role: staffRole('role').notNull(),
    cafeteriaId: uuid('cafeteria_id').references(() => cafeterias.id),
    contractorId: uuid('contractor_id').references(() => contractors.id),
    mobile: text('mobile'),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    ...ts(),
  },
  (t) => [uniqueIndex('staff_users_username_uq').on(sql`lower(${t.username})`), index('staff_users_cafeteria_idx').on(t.cafeteriaId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    kind: accountKind('kind').notNull().default('Customer'),
    code: text('code'), // system accounts: 'meal-revenue', 'payment-gateway', 'manual-cash', ...
    studentId: uuid('student_id').references(() => students.id),
    employeeId: uuid('employee_id').references(() => employees.id),
    balanceRial: rial('balance_rial')
      .notNull()
      .default(sql`0`),
    ...ts(),
  },
  (t) => [
    uniqueIndex('accounts_student_uq').on(t.studentId),
    uniqueIndex('accounts_employee_uq').on(t.employeeId),
    uniqueIndex('accounts_code_uq').on(t.code),
    check('accounts_balance_ck', sql`${t.kind} = 'System' OR ${t.balanceRial} >= 0`),
    check(
      'accounts_owner_ck',
      sql`(${t.kind} = 'System' AND ${t.code} IS NOT NULL AND ${t.studentId} IS NULL AND ${t.employeeId} IS NULL)
    OR (${t.kind} = 'Customer' AND num_nonnulls(${t.studentId}, ${t.employeeId}) = 1)`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    subjectType: text('subject_type').notNull(), // 'student' | 'employee' | 'staff'
    subjectId: uuid('subject_id').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_subject_idx').on(t.subjectType, t.subjectId),
    check('sessions_subject_ck', sql`${t.subjectType} IN ('student','employee','staff')`),
  ],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: id(),
    identifierHash: text('identifier_hash').notNull(),
    ip: text('ip').notNull(),
    success: boolean('success').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_attempts_ident_idx').on(t.identifierHash, t.createdAt), index('login_attempts_ip_idx').on(t.ip, t.createdAt)],
);

export const captchas = pgTable('captchas', {
  id: id(),
  answerHash: text('answer_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── catalog / menu ─────────────────────────────────────────────────────────
export const foods = pgTable('foods', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'),
  imagePath: text('image_path'),
  calories: integer('calories'),
  active: boolean('active').notNull().default(true),
  ...ts(),
});

export const mealSlots = pgTable(
  'meal_slots',
  {
    id: id(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...ts(),
  },
  (t) => [
    uniqueIndex('meal_slots_code_uq').on(t.code),
    check('meal_slots_time_ck', sql`${t.startTime} ~ '^[0-2][0-9]:[0-5][0-9]$' AND ${t.endTime} ~ '^[0-2][0-9]:[0-5][0-9]$' AND ${t.startTime} < ${t.endTime}`),
  ],
);

export const mealOfferings = pgTable(
  'meal_offerings',
  {
    id: id(),
    serviceDate: date('service_date', { mode: 'string' }).notNull(),
    mealSlotId: uuid('meal_slot_id')
      .notNull()
      .references(() => mealSlots.id),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id),
    cafeteriaId: uuid('cafeteria_id')
      .notNull()
      .references(() => cafeterias.id),
    capacity: integer('capacity').notNull(),
    reservedCount: integer('reserved_count').notNull().default(0),
    status: offeringStatus('status').notNull().default('Draft'),
    reserveOpensAt: timestamp('reserve_opens_at', { withTimezone: true }),
    reserveDeadline: timestamp('reserve_deadline', { withTimezone: true }).notNull(),
    cancelDeadline: timestamp('cancel_deadline', { withTimezone: true }),
    mealStartsAt: timestamp('meal_starts_at', { withTimezone: true }).notNull(),
    mealEndsAt: timestamp('meal_ends_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by'),
    ...ts(),
  },
  (t) => [
    check('meal_offerings_capacity_ck', sql`${t.capacity} > 0`),
    check('meal_offerings_reserved_ck', sql`${t.reservedCount} >= 0 AND ${t.reservedCount} <= ${t.capacity}`),
    check('meal_offerings_window_ck', sql`${t.mealStartsAt} < ${t.mealEndsAt} AND ${t.reserveDeadline} <= ${t.mealStartsAt}`),
    index('meal_offerings_date_idx').on(t.serviceDate, t.cafeteriaId),
    index('meal_offerings_slot_idx').on(t.mealSlotId),
    index('meal_offerings_food_idx').on(t.foodId),
  ],
);

export const offeringPrices = pgTable(
  'offering_prices',
  {
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => mealOfferings.id),
    customerGroup: customerGroup('customer_group').notNull(),
    priceRial: rial('price_rial').notNull(),
    ...ts(),
  },
  (t) => [primaryKey({ columns: [t.offeringId, t.customerGroup] }), check('offering_prices_ck', sql`${t.priceRial} >= 0`)],
);

// ── reservations / delivery ────────────────────────────────────────────────
export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    code: text('code').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => mealOfferings.id),
    customerGroup: customerGroup('customer_group').notNull(),
    priceRial: rial('price_rial').notNull(),
    status: reservationStatus('status').notNull().default('Reserved'),
    idempotencyKey: text('idempotency_key').notNull(),
    qrToken: text('qr_token').notNull(),
    paymentId: uuid('payment_id'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveredBy: uuid('delivered_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    ...ts(),
  },
  (t) => [
    uniqueIndex('reservations_idem_uq').on(t.idempotencyKey),
    uniqueIndex('reservations_qr_uq').on(t.qrToken),
    uniqueIndex('reservations_code_uq').on(t.code),
    uniqueIndex('reservations_active_uq')
      .on(t.accountId, t.offeringId)
      .where(sql`${t.status} IN ('Reserved','Delivered')`),
    check('reservations_price_ck', sql`${t.priceRial} >= 0`),
    index('reservations_offering_idx').on(t.offeringId, t.status),
    index('reservations_account_idx').on(t.accountId, t.createdAt),
  ],
);

export const reservationHistory = pgTable(
  'reservation_history',
  {
    id: id(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reservation_history_res_idx').on(t.reservationId)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => staffUsers.id),
    cafeteriaId: uuid('cafeteria_id').references(() => cafeterias.id),
    outcome: deliveryOutcome('outcome').notNull(),
    clientEventId: uuid('client_event_id'),
    deviceId: text('device_id'),
    offline: boolean('offline').notNull().default(false),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deliveries_client_event_uq').on(t.clientEventId),
    index('deliveries_res_idx').on(t.reservationId),
    index('deliveries_cafe_idx').on(t.cafeteriaId, t.createdAt),
  ],
);

// ── finance ────────────────────────────────────────────────────────────────
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: id(),
    type: text('type').notNull(), // ReservationDebit | CapacityRefund | CancelRefund | OnlinePayment | MANUAL_CASH | ManualAdjust ...
    idempotencyKey: text('idempotency_key').notNull(),
    trackingCode: text('tracking_code').notNull(),
    reason: text('reason'),
    actor: text('actor').notNull(),
    reservationId: uuid('reservation_id'),
    paymentId: uuid('payment_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_tx_idem_uq').on(t.idempotencyKey),
    uniqueIndex('ledger_tx_tracking_uq').on(t.trackingCode),
    index('ledger_tx_created_idx').on(t.createdAt),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amountRial: rial('amount_rial').notNull(),
    balanceAfter: rial('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ledger_entries_nonzero_ck', sql`${t.amountRial} <> 0`),
    index('ledger_entries_tx_idx').on(t.transactionId),
    index('ledger_entries_account_idx').on(t.accountId, t.createdAt),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    authority: text('authority'),
    amountRial: rial('amount_rial').notNull(),
    creditUsedRial: rial('credit_used_rial')
      .notNull()
      .default(sql`0`),
    status: paymentStatus('status').notNull().default('Pending'),
    items: jsonb('items').notNull(), // [{offeringId, priceRial}]
    refId: text('ref_id'),
    cardPan: text('card_pan'),
    gatewayCode: integer('gateway_code'),
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    ...ts(),
  },
  (t) => [
    uniqueIndex('payments_authority_uq').on(t.authority),
    index('payments_status_idx').on(t.status, t.createdAt),
    check('payments_amount_ck', sql`${t.amountRial} >= 0`),
  ],
);

// ── system ─────────────────────────────────────────────────────────────────
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    data: jsonb('data'),
    ip: text('ip'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt), index('audit_logs_entity_idx').on(t.entityType, t.entityId)],
);

export const importBatches = pgTable('import_batches', {
  id: id(),
  kind: text('kind').notNull().default('students'),
  fileName: text('file_name'),
  status: importStatus('status').notNull().default('Previewed'),
  fullSync: boolean('full_sync').notNull().default(false),
  summary: jsonb('summary'),
  createdBy: uuid('created_by').notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  ...ts(),
});

export const importRows = pgTable(
  'import_rows',
  {
    id: id(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id),
    rowNumber: integer('row_number').notNull(),
    action: text('action').notNull(), // NEW | UPDATE | CONFLICT | ERROR | UNCHANGED
    studentNumber: text('student_number'),
    payload: jsonb('payload'), // never contains raw national id
    errors: jsonb('errors'),
    conflictApproved: boolean('conflict_approved').notNull().default(false),
    studentId: uuid('student_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('import_rows_batch_idx').on(t.batchId, t.rowNumber)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    accountId: uuid('account_id').references(() => accounts.id), // null = broadcast
    audience: text('audience').notNull().default('personal'), // personal | students | employees | all
    title: text('title').notNull(),
    body: text('body').notNull(),
    kind: text('kind').notNull().default('info'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_account_idx').on(t.accountId, t.createdAt)],
);

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: id(),
    channel: text('channel').notNull().default('sms'),
    recipient: text('recipient').notNull(),
    body: text('body').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.sentAt} IS NULL`),
  ],
);

export const reservationReminders = pgTable(
  'reservation_reminders',
  {
    id: id(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reservation_reminders_res_uq').on(t.reservationId)],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobRuns = pgTable(
  'job_runs',
  {
    id: id(),
    job: text('job').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ok: boolean('ok'),
    detail: jsonb('detail'),
  },
  (t) => [index('job_runs_job_idx').on(t.job, t.startedAt)],
);
