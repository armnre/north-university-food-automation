/* eslint-disable no-misleading-character-class -- حذف کاراکترهای نامرئی/Bidi به‌صورت عمدی با کلاس کاراکتر انجام می‌شود. */
/**
 * نرمال‌سازی ورودی متنی فارسی/عربی.
 * این توابع هم در API (اعتبارسنجی ورودی) و هم در فرانت‌اند استفاده می‌شوند.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** تبدیل ارقام فارسی/عربی به ASCII. */
export function toAsciiDigits(input: string): string {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

/** تبدیل ارقام ASCII به فارسی (فقط برای نمایش). */
export function toPersianDigits(input: string | number): string {
  return String(input ?? '').replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

/** یکسان‌سازی حروف عربی/فارسی (ی، ک) و حذف نویزهای نامرئی. */
export function normalizeArabicChars(input: string): string {
  return (
    String(input ?? '')
      // نیم‌فاصلهٔ فارسی (U+200C) حفظ می‌شود؛ فقط نویزهای نامرئی و نشانه‌های جهتی حذف می‌شوند
      .replace(/[\u200B\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\uFEFF]/g, '')
      .replace(/[يى]/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/ة/g, 'ه')
      .replace(/[\u0640]/g, '')
      .replace(/\u064E|\u064F|\u0650|\u0651|\u0652|\u0670/g, '')
  );
}

/**
 * نرمال‌سازی رشتهٔ number-like: ارقام فارسی/عربی → ASCII، حذف فاصله، نیم‌فاصله و خط تیره.
 * برای شماره دانشجویی، کد ملی و مبلغ استفاده می‌شود.
 */
export function normalizeDigits(input: string): string {
  return toAsciiDigits(String(input ?? ''))
    .replace(/[\s\u200B\u200C\u200D\u200E\u200F\-\u2013\u2014.,/\\]/g, '')
    .trim();
}

/** نرمال‌سازی نام: حروف عربی، فاصله‌های اضافی و کاراکترهای کنترل. */
export function normalizeName(input: string): string {
  return normalizeArabicChars(String(input ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * محافظ CSV/Excel injection: خنثی‌سازی سلول‌هایی که با = + - @ شروع می‌شوند.
 * برای همهٔ خروجی‌های CSV و Excel گزارش‌ها استفاده می‌شود.
 */
export function sanitizeCell(input: unknown): string {
  let s = String(input ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s;
}

/** حذف کاراکترهای خطرناک از متن آزاد (بدون تغییر متن فارسی). */
export function cleanFreeText(input: string, maxLength = 2000): string {
  return normalizeArabicChars(String(input ?? ''))
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** نام کاربری مجاز: حروف انگلیسی کوچک، عدد، نقطه، خط تیره و زیرخط. */
/**
 * نرمال‌سازی نام کاربری: فقط trim و کوچک‌سازی.
 * فاصلهٔ داخلی عمداً حذف **نمی‌شود** تا دو ورودی متفاوت («admin user» و «adminuser»)
 * به یک نام کاربری یکسان نگاشت نشوند؛ اعتبارسنجی چنین ورودی‌ای را رد می‌کند.
 */
export function normalizeUsername(input: string): string {
  return String(input ?? '')
    .trim()
    .toLowerCase();
}

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

/** ماسک‌کردن شناسه‌ها برای نمایش/لاگ (بدون افشای مقدار کامل). */
export function maskMiddle(value: string, visibleStart = 0, visibleEnd = 4): string {
  const s = String(value ?? '');
  if (s.length <= visibleStart + visibleEnd) return '•'.repeat(Math.max(s.length, 4));
  return `${s.slice(0, visibleStart)}${'•'.repeat(Math.max(4, s.length - visibleStart - visibleEnd))}${s.slice(s.length - visibleEnd)}`;
}
