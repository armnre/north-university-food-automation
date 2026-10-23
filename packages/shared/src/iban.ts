import { normalizeDigits } from './normalize.js';

/**
 * شبای بانکی ایران (IR + ۲۴ رقم) با اعتبارسنجی mod-97 (ISO 13616).
 * مقدار خام شبا در دیتابیس **رمزنگاری** می‌شود (AES-256-GCM) و فقط
 * برای نقش امور مالی، آن هم ماسک‌شده، قابل مشاهده است.
 */

export const IBAN_PATTERN = /^IR\d{24}$/i;

/** نرمال‌سازی: حذف فاصله/خط تیره، ارقام فارسی، بزرگ‌سازی. */
export function normalizeIban(input: string): string {
  return normalizeDigits(
    String(input ?? '')
      .toUpperCase()
      .replace(/\s|-/g, ''),
  ).toUpperCase();
}

/** mod-97 روی رشتهٔ رقمی بزرگ (بدون از دست رفتن دقت). */
function mod97(digits: string): number {
  let remainder = 0;
  for (const ch of digits) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder;
}

/**
 * اعتبارسنجی کامل شبا: قالب + رقم کنترلی mod-97.
 * الگوریتم: چهار کاراکتر اول به انتها منتقل می‌شوند، حروف به عدد
 * (A=10 … Z=35) تبدیل می‌شوند و باقی‌مانده بر ۹۷ باید ۱ باشد.
 */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!IBAN_PATTERN.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return mod97(numeric) === 1;
}

/** ماسک برای نمایش: IR01••••••••••••••••1234 */
export function maskIban(input: string | null | undefined): string {
  const iban = normalizeIban(String(input ?? ''));
  if (iban.length < 10) return '—';
  return `${iban.slice(0, 4)}${'•'.repeat(Math.max(6, iban.length - 8))}${iban.slice(-4)}`;
}
