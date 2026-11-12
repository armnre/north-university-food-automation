const MAP: Record<string, string> = {};
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((d, i) => (MAP[d] = String(i)));
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((d, i) => (MAP[d] = String(i)));

/** Converts Persian/Arabic digits to ASCII and strips whitespace, ZWNJ and dashes. */
export function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => MAP[d] ?? d).replace(/[\s\u200c\u200f\-_]/g, '');
}

export function toPersianDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
}

/** Converts Persian/Arabic digits to ASCII only — keeps dashes, colons and signs (dates, times, negative amounts). */
export function latinDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => MAP[d] ?? d).replace(/[\u200c\u200f]/g, '').trim();
}
