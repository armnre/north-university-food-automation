import { normalizeDigits } from './digits.js';

/** Normalises a national id; pads 8–9 digit ids with leading zeros (common in Excel exports). */
export function normalizeNationalId(raw: string): string {
  const d = normalizeDigits(raw);
  return /^\d{8,10}$/.test(d) ? d.padStart(10, '0') : d;
}

/** Iranian national id check-digit validation. */
export function isValidNationalId(raw: string): boolean {
  const id = normalizeNationalId(raw);
  if (!/^\d{10}$/.test(id) || /^(\d)\1{9}$/.test(id)) return false;
  const digits = id.split('').map(Number);
  const check = digits[9]!;
  const sum = digits.slice(0, 9).reduce((s, d, i) => s + d * (10 - i), 0) % 11;
  return sum < 2 ? check === sum : check === 11 - sum;
}

export const nationalIdLast4 = (id: string) => normalizeNationalId(id).slice(-4);
