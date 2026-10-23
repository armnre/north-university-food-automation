/**
 * ثابت‌ها و وضعیت‌های دامنه‌ی کسب‌وکار.
 * این فایل تنها منبع حقیقت برای وضعیت‌ها است؛ هم API و هم فرانت‌اند از آن می‌خوانند.
 */

/** وضعیت تحصیلی/ثبتی دانشجو. فقط `Active` اجازهٔ ورود و رزرو دارد. */
export const STUDENT_STATUSES = ['Active', 'OnLeave', 'Withdrawn', 'Graduated', 'Removed'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/** وضعیت‌هایی که «غیرفعال» محسوب می‌شوند (ورود ممنوع، نشست‌ها باطل). */
export const INACTIVE_STUDENT_STATUSES: readonly StudentStatus[] = ['OnLeave', 'Withdrawn', 'Graduated', 'Removed'];

/** نقش‌های کارکنان سامانه (جدول `staff_users`). */
export const STAFF_ROLES = ['SuperAdmin', 'StudentAffairs', 'NutritionManager', 'Contractor', 'Operator', 'Finance'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** سطح سلسله‌مراتب نقش‌ها؛ عدد بزرگ‌تر = دسترسی بالاتر. */
export const ROLE_LEVEL: Record<StaffRole, number> = {
  Operator: 1,
  Contractor: 2,
  Finance: 3,
  NutritionManager: 4,
  StudentAffairs: 5,
  SuperAdmin: 6,
};

/** گروه مشتری (مشتریان سلف که حساب کیف پول دارند). */
export const CUSTOMER_GROUPS = ['Student', 'Employee', 'Faculty', 'Contractor'] as const;
export type CustomerGroup = (typeof CUSTOMER_GROUPS)[number];

/** نوع حساب در جدول `accounts`. */
export const ACCOUNT_KINDS = ['Student', 'Employee'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** وضعیت حساب کاربر کارمند/هیئت‌علمی/پیمانکار دانشگاه (جدول `employees`). */
export const EMPLOYEE_STATUSES = ['Active', 'Disabled'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** وضعیت حساب کاربر کارکنان (جدول `staff_users`). */
export const STAFF_STATUSES = ['Active', 'Disabled'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** وعده‌های غذایی. */
export const MEAL_SLOT_CODES = ['Breakfast', 'Lunch', 'Dinner'] as const;
export type MealSlotCode = (typeof MEAL_SLOT_CODES)[number];

/** وضعیت آیتم منو (`meal_offerings`). */
export const OFFERING_STATUSES = ['Draft', 'Published', 'Closed', 'Cancelled', 'SoldOut'] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

/** وضعیت رزرو. `effectiveStatus` محاسبه‌ای حذف شده است؛ وضعیت واقعی در دیتابیس نوشته می‌شود. */
export const RESERVATION_STATUSES = ['Reserved', 'Delivered', 'Cancelled', 'Rejected', 'Expired', 'NoShow'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** رزروهایی که ظرفیت را اشغال کرده‌اند (برای `reserved_count` و ایندکس یکتای جزئی). */
export const LIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = ['Reserved', 'Delivered'];

/** نوع تراکنش دفتر کل. */
export const LEDGER_TX_TYPES = [
  'ManualCredit',
  'ManualDebit',
  'OnlinePayment',
  'ReservationDebit',
  'CancellationRefund',
  'MealUnavailableRefund',
  'AdminRefund',
  'WithdrawalHold',
  'WithdrawalPaid',
  'WithdrawalRelease',
  'Correction',
] as const;
export type LedgerTxType = (typeof LEDGER_TX_TYPES)[number];

/** حساب‌های سیستمی (سمت مقابل دفتر کل دوطرفه). */
export const SYSTEM_ACCOUNTS = ['MEAL_REVENUE', 'MANUAL_CASH', 'GATEWAY_CLEARING', 'WITHDRAWAL_ESCROW', 'TREASURY'] as const;
export type SystemAccount = (typeof SYSTEM_ACCOUNTS)[number];

/** وضعیت پرداخت درگاه. */
export const PAYMENT_STATUSES = ['Pending', 'Paid', 'Failed', 'NeedsReview'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** وضعیت درخواست برداشت وجه. */
export const WITHDRAWAL_STATUSES = ['Pending', 'Approved', 'Paid', 'Rejected', 'Cancelled'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/** نتیجهٔ هر اسکن در صف تحویل (`deliveries`). */
export const DELIVERY_OUTCOMES = [
  'Accepted',
  'Duplicate',
  'Invalid',
  'WrongDay',
  'OutsideWindow',
  'Cancelled',
  'Expired',
  'WrongCafeteria',
  'OfflineConflict',
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** وضعیت دستهٔ واردسازی اکسل. */
export const IMPORT_BATCH_STATUSES = ['Preview', 'Committed', 'Cancelled', 'Failed', 'Undone'] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/** سیاست برخورد با ردیف خطادار در واردسازی. */
export const IMPORT_POLICIES = ['RejectAllOnError', 'SkipInvalidRows'] as const;
export type ImportPolicy = (typeof IMPORT_POLICIES)[number];

/** نوع رویداد اعلان (برای صف پیامک و اعلان درون‌برنامه‌ای). */
export const NOTIFICATION_EVENTS = [
  'reservation.confirmed',
  'reservation.cancelled',
  'meal.unavailable',
  'wallet.topped_up',
  'withdrawal.status',
  'meal.reminder',
  'security.new_login',
  'system.alert',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** نوع سوژهٔ نشست. */
export const SUBJECT_TYPES = ['Student', 'Employee', 'Staff'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** نام jobهای زمان‌بندی‌شده. */
export const JOBS = ['mark-no-show', 'payments-reconcile', 'ledger-reconcile', 'cleanup', 'notification-outbox', 'reminders'] as const;
export type JobName = (typeof JOBS)[number];

/** وضعیت اجرای job. */
export const JOB_STATUSES = ['Running', 'Ok', 'Failed', 'Skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
