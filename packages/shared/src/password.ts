import { normalizeUsername } from './normalize.js';

/**
 * سیاست رمز عبور کارکنان و کارمندان.
 * هم در API (اعتبارسنجی قطعی) و هم در فرانت‌اند (راهنمای لحظه‌ای) استفاده می‌شود.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export type PasswordIssue = { code: 'tooShort' | 'sameAsUsername' | 'tooCommon' | 'whitespaceOnly'; messageFa: string };

/** رمزهای بسیار رایج که حتی با طول کافی پذیرفته نمی‌شوند. */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0987654321',
  '1111111111',
  '0000000000',
  'passwordpassword',
  'qwertyuiop',
  'qwerty12345',
  'changeme123',
  'iloveyou123',
  'adminadmin1',
]);

/** بررسی سیاست رمز؛ فهرست مشکل‌ها (خالی = معتبر). */
export function validatePassword(password: string, username?: string): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) {
    issues.push({ code: 'tooShort', messageFa: `رمز عبور باید حداقل ${MIN_PASSWORD_LENGTH} کاراکتر باشد.` });
  }
  if (pw.trim().length === 0) {
    issues.push({ code: 'whitespaceOnly', messageFa: 'رمز عبور نمی‌تواند فقط فاصله باشد.' });
  }
  if (username) {
    const u = normalizeUsername(username);
    if (u.length >= 3 && pw.toLowerCase() === u) {
      issues.push({ code: 'sameAsUsername', messageFa: 'رمز عبور نمی‌تواند برابر با نام کاربری باشد.' });
    }
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    issues.push({ code: 'tooCommon', messageFa: 'این رمز بسیار رایج است؛ یک رمز قوی‌تر انتخاب کنید.' });
  }
  return issues;
}

export function isStrongEnoughPassword(password: string, username?: string): boolean {
  return validatePassword(password, username).length === 0;
}

/** نام کاربری معتبر؟ (حروف انگلیسی کوچک، عدد، نقطه، خط تیره، زیرخط) */
export function validateUsername(username: string): string | null {
  const u = normalizeUsername(username);
  if (u.length < 3 || u.length > 64) return 'نام کاربری باید بین ۳ و ۶۴ کاراکتر باشد.';
  if (/\s/.test(u)) return 'نام کاربری نمی‌تواند شامل فاصله باشد.';
  if (!/^[a-z0-9._-]+$/.test(u)) return 'نام کاربری فقط می‌تواند شامل حروف انگلیسی کوچک، عدد، نقطه، خط تیره و زیرخط باشد.';
  return null;
}
