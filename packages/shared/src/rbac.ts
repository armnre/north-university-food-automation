/**
 * Single source of truth for RBAC. The API guards every route with requirePermission(),
 * the web menu reads the same matrix, and docs/RBAC.md is generated from it (npm run docs:rbac).
 */
export const STAFF_ROLES = ['SuperAdmin', 'StudentAffairs', 'NutritionManager', 'Finance', 'Contractor', 'Operator'] as const;
export const CUSTOMER_ROLES = ['Student', 'Employee'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];
export type Role = StaffRole | CustomerRole;

export const PERMISSIONS = {
  dashboardView: 'مشاهده داشبورد مدیریت',
  studentsRead: 'مشاهده دانشجویان',
  studentsWrite: 'تغییر وضعیت دانشجو',
  employeesManage: 'مدیریت کارمندان',
  importsManage: 'ایمپورت اکسل دانشجویان',
  catalogWrite: 'مدیریت پیمانکار/سلف/غذا',
  menuWrite: 'مدیریت منو و قیمت',
  menuRead: 'مشاهده منو و آمار آشپزخانه',
  reservationsRead: 'مشاهده رزروها',
  reservationsAdminCancel: 'لغو اداری رزرو و لغو/اتمام وعده',
  deliveryScan: 'اسکن و تحویل غذا',
  financeRead: 'مشاهده دفتر کل',
  financeWrite: 'شارژ/تعدیل دستی',
  paymentsReview: 'تعیین‌تکلیف پرداخت‌های NeedsReview',
  reportsRead: 'گزارش‌ها',
  reportsFinance: 'گزارش‌های مالی کل',
  notificationsSend: 'ارسال اعلان',
  staffManage: 'مدیریت کاربران کارکنان',
  settingsWrite: 'ویرایش تنظیمات',
  auditRead: 'مشاهده رخدادهای حسابرسی',
  selfService: 'منو، رزرو، کیف پول و اعلان‌های شخصی',
} as const;
export type Permission = keyof typeof PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // SuperAdmin deliberately lacks financeWrite (segregation of duties).
  SuperAdmin: [
    'dashboardView',
    'studentsRead',
    'studentsWrite',
    'employeesManage',
    'importsManage',
    'catalogWrite',
    'menuWrite',
    'menuRead',
    'reservationsRead',
    'reservationsAdminCancel',
    'financeRead',
    'paymentsReview',
    'reportsRead',
    'reportsFinance',
    'notificationsSend',
    'staffManage',
    'settingsWrite',
    'auditRead',
  ],
  StudentAffairs: [
    'dashboardView',
    'studentsRead',
    'studentsWrite',
    'employeesManage',
    'importsManage',
    'reservationsRead',
    'reportsRead',
    'notificationsSend',
    'staffManage',
    'auditRead',
  ],
  NutritionManager: [
    'dashboardView',
    'catalogWrite',
    'menuWrite',
    'menuRead',
    'reservationsRead',
    'reservationsAdminCancel',
    'reportsRead',
    'notificationsSend',
    'staffManage',
  ],
  Finance: ['dashboardView', 'financeRead', 'financeWrite', 'reportsRead', 'reportsFinance', 'studentsRead'],
  Contractor: ['menuRead', 'reservationsRead', 'reportsRead'],
  Operator: ['deliveryScan', 'menuRead'],
  Student: ['selfService'],
  Employee: ['selfService'],
};

/** Which account kinds each staff role may create/edit. No role manages its own level or above. */
export const CAN_MANAGE: Record<StaffRole, readonly (StaffRole | 'Employee')[]> = {
  SuperAdmin: ['StudentAffairs', 'NutritionManager', 'Finance', 'Contractor', 'Operator', 'Employee'],
  StudentAffairs: ['Employee'],
  NutritionManager: ['Operator', 'Contractor'],
  Finance: [],
  Contractor: [],
  Operator: [],
};

export const hasPermission = (role: Role, p: Permission) => ROLE_PERMISSIONS[role].includes(p);
export const canManage = (actor: StaffRole, target: StaffRole | 'Employee') => CAN_MANAGE[actor].includes(target);

export function renderRbacMarkdown(): string {
  const roles = Object.keys(ROLE_PERMISSIONS) as Role[];
  const head = `| مجوز | ${roles.join(' | ')} |\n|---|${roles.map(() => '---').join('|')}|`;
  const rows = (Object.keys(PERMISSIONS) as Permission[]).map(
    (p) => `| \`${p}\` — ${PERMISSIONS[p]} | ${roles.map((r) => (hasPermission(r, p) ? '✓' : '')).join(' | ')} |`,
  );
  const mg = (Object.keys(CAN_MANAGE) as StaffRole[]).map((r) => `- **${r}**: ${CAN_MANAGE[r].join('، ') || '—'}`);
  return `# ماتریس RBAC\n\n> این فایل خودکار از \`packages/shared/src/rbac.ts\` تولید می‌شود (\`npm run docs:rbac\`). دستی ویرایش نکنید.\n\n${head}\n${rows.join('\n')}\n\n## سلسله‌مراتب ساخت حساب\n${mg.join('\n')}\n`;
}
