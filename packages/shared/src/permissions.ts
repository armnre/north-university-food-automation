import { ROLE_LEVEL, STAFF_ROLES, type StaffRole } from './constants.js';

/**
 * ماتریس مجوزها — تنها منبع حقیقت.
 * هم `requirePermission()` در API و هم منوی فرانت‌اند از همین جدول می‌خوانند،
 * بنابراین سند `docs/RBAC.md` و کد نمی‌توانند از هم واگرا شوند.
 *
 * قاعدهٔ پیش‌فرض: **رد**. هر route باید صریحاً یک مجوز بخواهد.
 */
export const PERMISSIONS = [
  'dashboard',
  'students',
  'studentStatus',
  'import',
  'employees',
  'operators',
  'catalog',
  'foods',
  'offerings',
  'prices',
  'reservations',
  'reservationCancel',
  'delivery',
  'deliveryAll',
  'finance',
  'financeWrite',
  'reports',
  'contractorReports',
  'audit',
  'settings',
  'users',
  'notify',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  // مدیر ارشد: همه‌چیز به‌جز عملیات مالی (تفکیک وظایف) — financeWrite ندارد.
  SuperAdmin: [
    'dashboard',
    'students',
    'studentStatus',
    'import',
    'employees',
    'operators',
    'catalog',
    'foods',
    'offerings',
    'prices',
    'reservations',
    'reservationCancel',
    'deliveryAll',
    'finance',
    'reports',
    'audit',
    'settings',
    'users',
    'notify',
  ],
  StudentAffairs: ['dashboard', 'students', 'studentStatus', 'import', 'employees', 'reservations', 'finance', 'reports', 'notify'],
  NutritionManager: ['dashboard', 'operators', 'catalog', 'foods', 'offerings', 'prices', 'reservations', 'reservationCancel', 'reports'],
  Finance: ['dashboard', 'finance', 'financeWrite', 'reports'],
  Contractor: ['contractorReports'],
  Operator: ['delivery'],
};

/** آیا این نقش این مجوز را دارد؟ */
export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** آیا نقش هر یک از این مجوزها را دارد؟ */
export function hasAnyPermission(role: StaffRole, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/**
 * سلسله‌مراتب ساخت/ویرایش حساب **کارکنان** (`staff_users`).
 * هیچ نقشی نمی‌تواند حساب هم‌سطح یا بالاتر از خودش بسازد یا ویرایش کند.
 * حساب `SuperAdmin` فقط با `SETUP_CODE` (یک‌بارمصرف) یا CLI `npm run create-admin` ساخته می‌شود
 * تا امکان قفل‌شدن سامانه یا ارتقای دسترسی از طریق API وجود نداشته باشد.
 */
export const MANAGEABLE_STAFF_ROLES: Record<StaffRole, readonly StaffRole[]> = {
  SuperAdmin: ['StudentAffairs', 'NutritionManager', 'Finance', 'Contractor', 'Operator'],
  StudentAffairs: [],
  NutritionManager: ['Operator', 'Contractor'],
  Finance: [],
  Contractor: [],
  Operator: [],
};

/**
 * چه کسی می‌تواند حساب **مشتری** (`employees`: کارمند/هیئت‌علمی/پیمانکار دانشگاه) بسازد؟
 * طبق تصمیم پروژه: `StudentAffairs` و `SuperAdmin`.
 */
export const CAN_MANAGE_EMPLOYEES: readonly StaffRole[] = ['SuperAdmin', 'StudentAffairs'];

/** آیا `actor` مجاز به ساخت/ویرایش حساب کارکنان با نقش `target` است؟ */
export function canManageStaffRole(actor: StaffRole, target: StaffRole): boolean {
  if (!MANAGEABLE_STAFF_ROLES[actor]?.includes(target)) return false;
  // محافظ دوم: حتی اگر جدول بالا اشتباه ویرایش شود، هم‌سطح/بالاتر هرگز مجاز نیست.
  return ROLE_LEVEL[target] < ROLE_LEVEL[actor];
}

/** همهٔ نقش‌ها (برای تست ماتریس کامل). */
export const ALL_ROLES: readonly StaffRole[] = STAFF_ROLES;

/** مجوزهای یک نقش به‌صورت آرایه (برای `/auth/me` و منوی فرانت). */
export function permissionsOf(role: StaffRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** نام فارسی نقش‌ها برای نمایش. */
export const ROLE_LABELS_FA: Record<StaffRole, string> = {
  SuperAdmin: 'مدیر ارشد سامانه',
  StudentAffairs: 'معاونت دانشجویی',
  NutritionManager: 'مدیر تغذیه',
  Contractor: 'پیمانکار تغذیه',
  Operator: 'اپراتور سلف',
  Finance: 'امور مالی',
};

/** نام فارسی مجوزها (برای صفحهٔ مدیریت کاربران و مستندات). */
export const PERMISSION_LABELS_FA: Record<Permission, string> = {
  dashboard: 'داشبورد مدیریتی',
  students: 'مشاهدهٔ دانشجویان',
  studentStatus: 'تغییر وضعیت دانشجو',
  import: 'واردسازی اکسل دانشجویان',
  employees: 'مدیریت کارمندان/هیئت‌علمی (مشتری سلف)',
  operators: 'مدیریت کارکنان سلف و پیمانکاران',
  catalog: 'مدیریت پیمانکاران و سلف‌ها',
  foods: 'مدیریت غذاها',
  offerings: 'مدیریت منو و وعده‌ها',
  prices: 'قیمت‌گذاری هر گروه مشتری',
  reservations: 'مشاهدهٔ رزروها',
  reservationCancel: 'لغو اداری رزرو',
  delivery: 'تحویل غذا در سلف منتسب',
  deliveryAll: 'تحویل غذا در همهٔ سلف‌ها',
  finance: 'مشاهدهٔ دفتر کل و مالی',
  financeWrite: 'شارژ/برداشت دستی کیف پول',
  reports: 'گزارش‌های مدیریتی',
  contractorReports: 'گزارش محدود به قرارداد',
  audit: 'مشاهدهٔ لاگ ممیزی',
  settings: 'تنظیمات سامانه',
  users: 'مدیریت همهٔ کاربران',
  notify: 'ارسال اعلان',
};
