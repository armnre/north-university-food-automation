import { toPersianDigits } from './normalize.js';

/**
 * پول در سامانه:
 *  - واحد ذخیره و انتقال: **ریال**، عدد صحیح (`bigint` در دیتابیس).
 *  - واحد نمایش: **تومان**.
 *  - هیچ‌گاه از `float` برای مبلغ استفاده نمی‌شود.
 */

export const RIAL_PER_TOMAN = 10;

/** سقف مبلغ قابل نمایش/پردازش بدون از دست رفتن دقت در JavaScript. */
export const MAX_SAFE_RIAL = Number.MAX_SAFE_INTEGER;

/** تبدیل ریال → تومان (عدد صحیح؛ باقی‌مانده به سمت بالا گرد نمی‌شود). */
export function rialToToman(rial: number | bigint): number {
  return Number(BigInt(Math.trunc(Number(rial))) / 10n);
}

/** تبدیل تومان → ریال. */
export function tomanToRial(toman: number | bigint): number {
  return Number(BigInt(Math.trunc(Number(toman))) * 10n);
}

/** آیا مبلغ ریال صحیح و در بازهٔ مجاز است؟ */
export function isValidRial(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX_SAFE_RIAL;
}

const faGrouped = (n: number): string => new Intl.NumberFormat('en-US').format(Math.trunc(n));

/** نمایش تومان با ارقام فارسی: «۱۲٬۵۰۰ تومان» */
export function formatToman(rial: number | bigint | null | undefined, withUnit = true): string {
  if (rial == null) return '—';
  const t = rialToToman(Number(rial));
  const grouped = faGrouped(t).replace(/,/g, '٬');
  return withUnit ? `${toPersianDigits(grouped)} تومان` : toPersianDigits(grouped);
}

/** نمایش ریال با ارقام فارسی: «۱۲۵٬۰۰۰ ریال» */
export function formatRial(rial: number | bigint | null | undefined, withUnit = true): string {
  if (rial == null) return '—';
  const grouped = faGrouped(Number(rial)).replace(/,/g, '٬');
  return withUnit ? `${toPersianDigits(grouped)} ریال` : toPersianDigits(grouped);
}

/**
 * تبدیل ورودی کاربر (تومان، ممکن است با ارقام فارسی/جداکننده هزارگان) به ریال.
 * در صورت نامعتبر بودن `null` برمی‌گرداند.
 */
export function parseTomanInput(input: string): number | null {
  const cleaned = String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s,،٬.]/g, '');
  if (!/^\d{1,15}$/.test(cleaned)) return null;
  const toman = Number(cleaned);
  if (!Number.isSafeInteger(toman)) return null;
  return tomanToRial(toman);
}

/** جمع امن آرایه‌ای از مبالغ ریالی. */
export function sumRial(values: Iterable<number | bigint | null | undefined>): number {
  let acc = 0n;
  for (const v of values) acc += BigInt(Math.trunc(Number(v ?? 0)));
  return Number(acc);
}
