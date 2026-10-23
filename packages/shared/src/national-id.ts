import { normalizeDigits } from './normalize.js';

/**
 * کد ملی ایران: نرمال‌سازی و اعتبارسنجی رقم کنترلی.
 *
 * نکتهٔ امنیتی: مقدار خام کد ملی **هرگز** ذخیره، لاگ یا برگردانده نمی‌شود.
 * فقط HMAC-SHA256 با pepper (ستون `national_id_hash`) و ۴ رقم آخر ذخیره می‌شود.
 */

/** آیا رشته پس از نرمال‌سازی ۱۰ رقم است؟ */
export function isTenDigits(raw: string): boolean {
  return /^\d{10}$/.test(normalizeDigits(raw));
}

/**
 * اعتبارسنجی کد ملی ۱۰ رقمی با رقم کنترلی (الگوریتم استاندارد).
 * مقادیر یکسان (۱۱۱۱۱۱۱۱۱۱) و رشته‌های کوتاه‌تر نامعتبرند.
 * کدهای ۱۰ رقمی که با صفر شروع می‌شوند معتبرند (پدیدهٔ رایج).
 */
export function isValidNationalId(raw: string): boolean {
  const c = normalizeDigits(raw);
  if (!/^\d{10}$/.test(c)) return false;
  if (/^(\d)\1{9}$/.test(c)) return false;
  const check = Number(c[9]);
  const sum = c
    .slice(0, 9)
    .split('')
    .reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const rest = sum % 11;
  return rest < 2 ? check === rest : check === 11 - rest;
}

/** ۴ رقم آخر کد ملی (برای نمایش ماسک‌شده). اگر نامعتبر باشد رشتهٔ خالی. */
export function nationalIdLast4(raw: string): string {
  const c = normalizeDigits(raw);
  return /^\d{10}$/.test(c) ? c.slice(-4) : '';
}

/** شکل ماسک‌شده برای نمایش: ••••••۱۲۳۴ */
export function maskNationalId(last4: string | null | undefined): string {
  const l4 = String(last4 ?? '')
    .replace(/\D/g, '')
    .slice(-4);
  return l4 ? `••••••${l4}` : '••••••••••';
}

/**
 * شماره دانشجویی: ۵ تا ۱۵ رقم. صفرهای ابتدایی **حفظ** می‌شوند
 * (به همین دلیل نوع ستون متن است، نه عدد).
 */
export function normalizeStudentNumber(raw: string): string {
  return normalizeDigits(raw);
}

export function isValidStudentNumber(raw: string): boolean {
  return /^\d{5,15}$/.test(normalizeDigits(raw));
}

/** شماره موبایل ایران (اختیاری برای کارمندان): ۰۹xxxxxxxxx یا +۹۸۹xxxxxxxxx */
export function normalizeMobile(raw: string): string {
  const d = normalizeDigits(String(raw ?? '').replace(/[+()]/g, ''));
  if (/^0098\d{10}$/.test(d)) return `0${d.slice(4)}`;
  if (/^98\d{10}$/.test(d)) return `0${d.slice(2)}`;
  if (/^9\d{9}$/.test(d)) return `0${d}`;
  return d;
}

export function isValidMobile(raw: string): boolean {
  return /^09\d{9}$/.test(normalizeMobile(raw));
}
