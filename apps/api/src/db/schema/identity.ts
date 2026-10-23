import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, id, isActive, updatedAt } from './base.js';
import { cafeterias, contractors } from './catalog.js';

/**
 * هویت: دانشجویان، کارمندان (مشتریان سلف)، کارکنان سامانه، حساب‌های کیف پول،
 * نشست‌ها، تلاش‌های ورود و کپچاها.
 */

export const students = pgTable(
  'students',
  {
    id: id(),
    /** متن — صفرهای ابتدایی حفظ می‌شوند. */
    studentNumber: varchar('student_number', { length: 20 }).notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    faculty: varchar('faculty', { length: 200 }).notNull().default(''),
    major: varchar('major', { length: 200 }).notNull().default(''),
    degree: varchar('degree', { length: 100 }).notNull().default(''),
    entryYear: integer('entry_year'),
    /** HMAC-SHA256 کد ملی با pepper. مقدار خام هرگز ذخیره نمی‌شود. */
    nationalIdHash: varchar('national_id_hash', { length: 64 }).notNull(),
    nationalIdLast4: varchar('national_id_last4', { length: 4 }).notNull().default(''),
    /** Active | OnLeave | Withdrawn | Graduated | Removed */
    status: varchar('status', { length: 20 }).notNull().default('Active'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    /**
     * آخرین دستهٔ واردسازی که این دانشجو را نوشته است.
     * کلید خارجی در migration `0001_triggers_grants.sql` اضافه می‌شود
     * (برای پرهیز از وابستگی حلقوی بین ماژول‌های schema).
     */
    lastImportBatchId: uuid('last_import_batch_id'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('students_student_number_key').on(t.studentNumber),
    uniqueIndex('students_national_id_hash_key').on(t.nationalIdHash),
    index('students_status_idx').on(t.status),
    index('students_faculty_idx').on(t.faculty),
    index('students_last_import_batch_idx').on(t.lastImportBatchId),
    check('students_status_check', sql`${t.status} IN ('Active','OnLeave','Withdrawn','Graduated','Removed')`),
    check('students_student_number_check', sql`char_length(${t.studentNumber}) BETWEEN 5 AND 20`),
    check('students_national_id_hash_check', sql`char_length(${t.nationalIdHash}) = 64`),
    check('students_national_id_last4_check', sql`char_length(${t.nationalIdLast4}) <= 4`),
  ],
);

/**
 * کارمند / هیئت‌علمی / پیمانکار دانشگاه — مشتری سلف با ورود نام‌کاربری+رمز.
 * گروه مشتری تعیین‌کنندهٔ قیمت هر وعده است.
 */
export const employees = pgTable(
  'employees',
  {
    id: id(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    /** Employee | Faculty | Contractor */
    customerGroup: varchar('customer_group', { length: 20 }).notNull().default('Employee'),
    /** اختیاری — فقط ۴ رقم آخر، مقدار خام هرگز ذخیره نمی‌شود. */
    nationalIdLast4: varchar('national_id_last4', { length: 4 }),
    mobile: varchar('mobile', { length: 20 }),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    /** Active | Disabled */
    status: varchar('status', { length: 20 }).notNull().default('Active'),
    personnelCode: varchar('personnel_code', { length: 40 }),
    department: varchar('department', { length: 200 }).notNull().default(''),
    createdBy: uuid('created_by'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('employees_username_key').on(t.username),
    uniqueIndex('employees_personnel_code_key').on(t.personnelCode),
    index('employees_status_idx').on(t.status),
    index('employees_customer_group_idx').on(t.customerGroup),
    check('employees_customer_group_check', sql`${t.customerGroup} IN ('Employee','Faculty','Contractor')`),
    check('employees_status_check', sql`${t.status} IN ('Active','Disabled')`),
    check('employees_username_check', sql`${t.username} ~ '^[a-z0-9._-]{3,64}$'`),
  ],
);

/** کارکنان سامانه (نقش‌های مدیریتی). */
export const staffUsers = pgTable(
  'staff_users',
  {
    id: id(),
    username: varchar('username', { length: 64 }).notNull(),
    /** Argon2id. رمزهای قدیمی PBKDF2 در اولین ورود موفق rehash می‌شوند. */
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    /** SuperAdmin | StudentAffairs | NutritionManager | Contractor | Operator | Finance */
    role: varchar('role', { length: 30 }).notNull(),
    /** Active | Disabled */
    status: varchar('status', { length: 20 }).notNull().default('Active'),
    contractorId: uuid('contractor_id').references(() => contractors.id, { onDelete: 'restrict' }),
    cafeteriaId: uuid('cafeteria_id').references(() => cafeterias.id, { onDelete: 'restrict' }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdBy: uuid('created_by'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('staff_users_username_key').on(t.username),
    index('staff_users_role_idx').on(t.role),
    index('staff_users_status_idx').on(t.status),
    index('staff_users_contractor_idx').on(t.contractorId),
    index('staff_users_cafeteria_idx').on(t.cafeteriaId),
    check('staff_users_role_check', sql`${t.role} IN ('SuperAdmin','StudentAffairs','NutritionManager','Contractor','Operator','Finance')`),
    check('staff_users_status_check', sql`${t.status} IN ('Active','Disabled')`),
    check('staff_users_username_check', sql`${t.username} ~ '^[a-z0-9._-]{3,64}$'`),
  ],
);

/**
 * حساب کیف پول. هر دانشجو/کارمند دقیقاً یک حساب دارد.
 * `balance_rial` موجودی کش‌شده است؛ منبع حقیقت `ledger_entries` است و
 * job `ledger-reconcile` هر شب برابری این دو را بررسی می‌کند.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    /** Student | Employee */
    kind: varchar('kind', { length: 20 }).notNull(),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'restrict' }),
    /** Student | Employee | Faculty | Contractor — گروه مشتری برای قیمت‌گذاری */
    customerGroup: varchar('customer_group', { length: 20 }).notNull(),
    balanceRial: bigint('balance_rial', { mode: 'number' }).notNull().default(0),
    isActive: isActive(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_student_id_key').on(t.studentId),
    uniqueIndex('accounts_employee_id_key').on(t.employeeId),
    check('accounts_balance_non_negative', sql`${t.balanceRial} >= 0`),
    check('accounts_balance_safe_range', sql`${t.balanceRial} <= 9000000000000000`),
    check('accounts_kind_check', sql`${t.kind} IN ('Student','Employee')`),
    check('accounts_customer_group_check', sql`${t.customerGroup} IN ('Student','Employee','Faculty','Contractor')`),
    // دقیقاً یکی از دو ارجاع پر باشد
    check('accounts_subject_exclusive', sql`(${t.studentId} IS NULL) <> (${t.employeeId} IS NULL)`),
    // سازگاری نوع حساب با ارجاع آن
    check(
      'accounts_kind_matches_subject',
      sql`(${t.kind} = 'Student' AND ${t.studentId} IS NOT NULL) OR (${t.kind} = 'Employee' AND ${t.employeeId} IS NOT NULL)`,
    ),
    check(
      'accounts_group_matches_kind',
      sql`(${t.kind} = 'Student' AND ${t.customerGroup} = 'Student') OR (${t.kind} = 'Employee' AND ${t.customerGroup} <> 'Student')`,
    ),
  ],
);

/**
 * نشست‌ها. فقط SHA-256 توکن ذخیره می‌شود؛ توکن خام تنها یک بار در کوکی
 * `__Host-sid` (HttpOnly; Secure; SameSite=Strict; Path=/) به کلاینت می‌رسد.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Student | Employee | Staff */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 400 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** سقف مطلق نشست (بدون تمدید لغزان) */
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: varchar('revoke_reason', { length: 60 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_expires_at_idx').on(t.expiresAt),
    index('sessions_subject_idx').on(t.subjectType, t.subjectId),
    check('sessions_subject_type_check', sql`${t.subjectType} IN ('Student','Employee','Staff')`),
    check('sessions_token_hash_check', sql`char_length(${t.tokenHash}) = 64`),
  ],
);

/** تلاش‌های ورود (موفق و ناموفق) برای محدودیت نرخ بر پایهٔ شناسه+IP. */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: id(),
    /** SHA-256 شناسهٔ ورود (شماره دانشجویی/نام کاربری) — مقدار خام ذخیره نمی‌شود. */
    identifierHash: varchar('identifier_hash', { length: 64 }).notNull(),
    /** Student | Employee | Staff */
    subjectType: varchar('subject_type', { length: 20 }).notNull(),
    ip: varchar('ip', { length: 64 }).notNull().default(''),
    success: boolean('success').notNull().default(false),
    /** قفل فعال تا این لحظه (NULL = بدون قفل) */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('login_attempts_identifier_ip_idx').on(t.identifierHash, t.ip, t.createdAt),
    index('login_attempts_identifier_idx').on(t.identifierHash, t.createdAt),
    index('login_attempts_ip_idx').on(t.ip, t.createdAt),
    check('login_attempts_subject_type_check', sql`${t.subjectType} IN ('Student','Employee','Staff')`),
  ],
);

/** کپچای یک‌بارمصرف (ساخت خود سامانه؛ بدون وابستگی بیرونی). */
export const captchas = pgTable(
  'captchas',
  {
    id: id(),
    /** SHA-256 پاسخ صحیح (پاسخ خام ذخیره نمی‌شود). */
    answerHash: varchar('answer_hash', { length: 64 }).notNull(),
    /** Math | Text */
    kind: varchar('kind', { length: 10 }).notNull().default('Math'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('captchas_expires_at_idx').on(t.expiresAt), check('captchas_kind_check', sql`${t.kind} IN ('Math','Text')`)],
);

export type StudentRow = typeof students.$inferSelect;
export type EmployeeRow = typeof employees.$inferSelect;
export type StaffUserRow = typeof staffUsers.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
