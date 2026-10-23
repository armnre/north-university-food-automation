import { STAFF_ROLES } from './constants.js';
import {
  CAN_MANAGE_EMPLOYEES,
  MANAGEABLE_STAFF_ROLES,
  PERMISSION_LABELS_FA,
  PERMISSIONS,
  ROLE_LABELS_FA,
  hasPermission,
} from './permissions.js';

/**
 * تولید خودکار محتوای `docs/RBAC.md` مستقیماً از ماتریس `packages/shared/src/permissions.ts`.
 * هرگونه تغییر در نقش‌ها یا مجوزها بدون اجرای `npm run docs:rbac` باعث شکست تست واحد می‌شود.
 */
export function renderRbacMarkdown(): string {
  const headerCols = ['مجوز', 'عنوان فارسی', ...STAFF_ROLES.map((r) => `\`${r}\` (${ROLE_LABELS_FA[r]})`)];
  const alignCols = [':---', ':---', ...STAFF_ROLES.map(() => ':---:')];

  const matrixLines = [
    `| ${headerCols.join(' | ')} |`,
    `| ${alignCols.join(' | ')} |`,
    ...PERMISSIONS.map((perm) => {
      const cells = STAFF_ROLES.map((role) => (hasPermission(role, perm) ? '✓' : '—'));
      return `| \`${perm}\` | ${PERMISSION_LABELS_FA[perm]} | ${cells.join(' | ')} |`;
    }),
  ];

  const hierarchyLines = [
    '| نقش اقدام‌کننده | عنوان فارسی | نقش‌های کارکنان قابل ایجاد/ویرایش/ریست رمز | مدیریت مشتریان کارمند (`Employee`) |',
    '| :--- | :--- | :--- | :---: |',
    ...STAFF_ROLES.map((role) => {
      const targets = MANAGEABLE_STAFF_ROLES[role];
      const targetText =
        targets.length > 0 ? targets.map((t) => `\`${t}\` (${ROLE_LABELS_FA[t]})`).join('، ') : '— (فاقد مجوز مدیریت کارکنان)';
      const canEmp = (CAN_MANAGE_EMPLOYEES as readonly string[]).includes(role) ? '✓' : '—';
      return `| \`${role}\` | ${ROLE_LABELS_FA[role]} | ${targetText} | ${canEmp} |`;
    }),
  ];

  return [
    '# کنترل دسترسی مبتنی بر نقش و تفکیک وظایف (`docs/RBAC.md`)',
    '',
    '> **این فایل به‌صورت خودکار با دستور `npm run docs:rbac` از روی `packages/shared/src/permissions.ts` تولید شده است.**',
    '> هرگونه ویرایش دستی بدون به‌روزرسانی منبع واحد حقیقت باعث شکست تست واحد در CI خواهد شد.',
    '',
    'منبع واحد حقیقت برای نقش‌ها و مجوزها فایل `packages/shared/src/permissions.ts` است که هم در میان‌افزارهای امنیتی بک‌اند (`apps/api`) و هم برای نمایش منوهای فرانت‌اند (`apps/web`) استفاده می‌شود. کنترل امنیتی واقعی همیشه سمت سرور انجام می‌گیرد و هر مسیر فاقد مجوز صریح با خطای `403` رد می‌شود.',
    '',
    '---',
    '',
    '## ۱. ماتریس نقش‌های کارکنان و مجوزها',
    '',
    ...matrixLines,
    '',
    '---',
    '',
    '## ۲. ماتریس سلسله‌مراتب مدیریت حساب‌ها',
    '',
    ...hierarchyLines,
    '',
    '---',
    '',
    '## ۳. قواعد تفکیک وظایف و کنترل‌های اجباری سرور',
    '',
    '1. **تفکیک وظایف مالی (`Segregation of Duties`):** نقش `SuperAdmin` به‌صورت عمدی مجوز `financeWrite` را **ندارد** (نمی‌تواند به حساب هیچ کاربری شارژ دستی اضافه یا کسر کند) و نقش `Finance` نیز مجوز `settings`، `users` یا `audit` را ندارد تا هیچ حسابی نتواند هم کاربر بسازد و هم تراز مالی را تغییر دهد.',
    '2. **جلوگیری از ارتقای دسترسی افقی و عمودی:** هیچ نقشی نمی‌تواند حسابی هم‌سطح یا بالاتر از نقش خود ایجاد، ویرایش، غیرفعال یا بازنشانی رمز کند (`canManageStaffRole`).',
    '3. **محدودسازی دامنهٔ داده (`Row/Scope Isolation`):** نقش `Operator` فقط مجاز به اسکن، مانیفست آفلاین و تحویل رزروهای سلف تخصیص‌یافته به خود (`cafeteriaId`) است و نقش `Contractor` فقط گزارش وعده‌های مرتبط با قرارداد پیمانکاری خود (`contractorId`) را مشاهده می‌کند.',
    '4. **جداسازی کامل مشتریان از پنل کارکنان:** نشست‌های دانشجو و کارمند (`Customer`) به هیچ‌یک از مسیرهای مدیریتی دسترسی ندارند و کارکنان نیز نمی‌توانند با نشست مدیریتی مسیرهای `/api/v1/me/*` را فراخوانی کنند.',
    '',
  ].join('\n');
}
