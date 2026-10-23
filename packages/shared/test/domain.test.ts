import { describe, expect, it } from 'vitest';
import {
  cleanFreeText,
  DEFAULT_SETTINGS,
  isValidIban,
  isValidNationalId,
  maskIban,
  maskNationalId,
  normalizeDigits,
  normalizeIban,
  normalizeName,
  normalizeUsername,
  parseTomanInput,
  rialToToman,
  sanitizeCell,
  tomanToRial,
  validatePassword,
  validateSettingValue,
  validateUsername,
} from '../src/index.js';

/** ساخت کد ملی معتبر برای تست (۹ رقم + رقم کنترلی). */
function makeNationalIdForTest2(seed: number): string {
  const base = String(100_000_000 + (Math.abs(seed) % 899_999_999))
    .slice(0, 9)
    .padStart(9, '0');
  const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const rest = sum % 11;
  return `${base}${rest < 2 ? rest : 11 - rest}`;
}

describe('کد ملی', () => {
  it('کد معتبر پذیرفته و رقم کنترلی اشتباه رد می‌شود', () => {
    const valid = makeNationalIdForTest2(1234);
    expect(isValidNationalId(valid)).toBe(true);
    const broken = `${valid.slice(0, 9)}${(Number(valid[9]) + 1) % 10}`;
    expect(isValidNationalId(broken)).toBe(false);
  });

  it('ارقام یکسان، طول اشتباه و ورودی خالی نامعتبرند', () => {
    expect(isValidNationalId('1111111111')).toBe(false);
    expect(isValidNationalId('0000000000')).toBe(false);
    expect(isValidNationalId('12345')).toBe(false);
    expect(isValidNationalId('')).toBe(false);
    expect(isValidNationalId('abcd123456')).toBe(false);
  });

  it('کد ملی با صفر ابتدایی معتبر است و ارقام فارسی/عربی نرمال می‌شوند', () => {
    const withZero = makeNationalIdForTest2(900_000_001).replace(/^1/, '0');
    // رقم کنترلی برای مقدار جدید دوباره محاسبه می‌شود
    const base = withZero.slice(0, 9);
    const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
    const rest = sum % 11;
    const valid = `${base}${rest < 2 ? rest : 11 - rest}`;
    expect(isValidNationalId(valid)).toBe(true);

    const persian = valid.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);
    expect(isValidNationalId(persian)).toBe(true);
    const arabic = valid.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d);
    expect(isValidNationalId(arabic)).toBe(true);
  });

  it('ماسک فقط ۴ رقم آخر را نشان می‌دهد', () => {
    expect(maskNationalId('1234')).toBe('••••••1234');
    expect(maskNationalId('')).toBe('••••••••••');
    expect(maskNationalId(null)).toBe('••••••••••');
  });
});

describe('نرمال‌سازی ورودی', () => {
  it('ارقام فارسی/عربی و جداکننده‌ها حذف می‌شوند', () => {
    expect(normalizeDigits('۴۰۰۱۲۳۴۵۶')).toBe('400123456');
    expect(normalizeDigits('٤٠٠١٢٣٤٥٦')).toBe('400123456');
    expect(normalizeDigits(' 400-123 456 ')).toBe('400123456');
    expect(normalizeDigits('400\u200c123')).toBe('400123');
  });

  it('نیم‌فاصلهٔ فارسی در نام حفظ می‌شود ولی نویزهای جهتی حذف می‌شوند', () => {
    expect(normalizeName('علی\u200cرضا')).toBe('علی\u200cرضا');
    expect(normalizeName('  علی   رضا  ')).toBe('علی رضا');
    // نشانهٔ جهتی حذف و «ي» عربی به «ی» تبدیل می‌شود (بخش لاتین دست‌نخورده می‌ماند)
    expect(normalizeName('علي\u202ereza')).toBe('علیreza');
    // حذف `<` و `>` کار `cleanFreeText` است (برای متن‌های آزادِ ذخیره‌شده)
    expect(cleanFreeText('نام<script>')).toBe('نامscript');
  });

  it('نام کاربری نرمال و اعتبارسنجی می‌شود', () => {
    expect(normalizeUsername('  Admin.User-1 ')).toBe('admin.user-1');
    expect(validateUsername('admin.user-1')).toBeNull();
    expect(validateUsername('ab')).toMatch(/۳ و ۶۴/);
    expect(validateUsername('bad user')).not.toBeNull();
    expect(validateUsername('کاربر')).not.toBeNull();
  });

  it('محافظ CSV injection فقط سلول‌های خطرناک را خنثی می‌کند', () => {
    expect(sanitizeCell('=1+1')).toBe("'=1+1");
    expect(sanitizeCell('+cmd')).toBe("'+cmd");
    expect(sanitizeCell('-1')).toBe("'-1");
    expect(sanitizeCell('@x')).toBe("'@x");
    expect(sanitizeCell('سلام ۱۲۳')).toBe('سلام ۱۲۳');
  });
});

describe('شبا (IBAN)', () => {
  it('شبای معتبر با mod-97 پذیرفته و نامعتبر رد می‌شود', () => {
    expect(isValidIban('IR820540102680020817909002')).toBe(true);
    expect(isValidIban('ir82 0540 1026 8002 0817 9090 02')).toBe(true);
    expect(isValidIban('IR830540102680020817909002')).toBe(false);
    expect(isValidIban('IR82054010268002081790900')).toBe(false);
    expect(isValidIban('DE89370400440532013000')).toBe(false);
    expect(isValidIban('')).toBe(false);
  });

  it('نرمال‌سازی و ماسک شبا', () => {
    expect(normalizeIban('ir82-0540 102680020817909002')).toBe('IR820540102680020817909002');
    const masked = maskIban('IR820540102680020817909002');
    expect(masked.startsWith('IR82')).toBe(true);
    expect(masked.endsWith('9002')).toBe(true);
    expect(masked).toContain('•');
    expect(masked).not.toContain('05401026');
  });
});

describe('پول (ریال/تومان)', () => {
  it('تبدیل ریال به تومان و برعکس بدون خطای اعشار', () => {
    expect(rialToToman(123_450)).toBe(12_345);
    expect(tomanToRial(12_345)).toBe(123_450);
    expect(rialToToman(999)).toBe(99);
    expect(tomanToRial(0)).toBe(0);
  });

  it('ورودی تومان با ارقام فارسی و جداکننده هزارگان پارس می‌شود', () => {
    expect(parseTomanInput('۱۲٬۵۰۰')).toBe(125_000);
    expect(parseTomanInput('12,500')).toBe(125_000);
    expect(parseTomanInput(' 12500 ')).toBe(125_000);
    expect(parseTomanInput('abc')).toBeNull();
    expect(parseTomanInput('-5')).toBeNull();
    expect(parseTomanInput('')).toBeNull();
  });
});

describe('رمز عبور', () => {
  it('حداقل ۱۰ کاراکتر و نامساوی با نام کاربری', () => {
    expect(validatePassword('short')).toHaveLength(1);
    expect(validatePassword('admin.user-1', 'admin.user-1').map((i) => i.code)).toContain('sameAsUsername');
    expect(validatePassword('1234567890')).not.toHaveLength(0); // رایج
    expect(validatePassword('a-strong-unique-password', 'admin')).toHaveLength(0);
    expect(validatePassword('          ')).not.toHaveLength(0);
  });
});

describe('تنظیمات سامانه', () => {
  it('مقدارهای پیش‌فرض معتبر و در بازه هستند', () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const result = validateSettingValue(key as keyof typeof DEFAULT_SETTINGS, value);
      expect(result.ok, `${key} = ${value}`).toBe(true);
    }
    expect(DEFAULT_SETTINGS.student_cancellation_enabled).toBe('false');
    expect(DEFAULT_SETTINGS.cancel_cutoff_hours).toBe('12');
    expect(DEFAULT_SETTINGS.noshow_grace_minutes).toBe('30');
    expect(DEFAULT_SETTINGS.noshow_refund).toBe('false');
    expect(DEFAULT_SETTINGS.scan_window_before_minutes).toBe('60');
    expect(DEFAULT_SETTINGS.scan_window_after_minutes).toBe('60');
    expect(DEFAULT_SETTINGS.reminder_hours_before_meal).toBe('2');
    expect(DEFAULT_SETTINGS.online_payment_enabled).toBe('false');
  });

  it('خارج از بازه یا نوع اشتباه رد می‌شود', () => {
    expect(validateSettingValue('cancel_cutoff_hours', '9999').ok).toBe(false);
    expect(validateSettingValue('cancel_cutoff_hours', '-1').ok).toBe(false);
    expect(validateSettingValue('cancel_cutoff_hours', 'abc').ok).toBe(false);
    expect(validateSettingValue('online_payment_enabled', 'maybe').ok).toBe(false);
    expect(validateSettingValue('online_payment_enabled', 'TRUE').ok).toBe(true);
    expect(validateSettingValue('supportText', 'x'.repeat(3001)).ok).toBe(false);
    expect(validateSettingValue('min_gateway_payable_rial', '10').ok).toBe(false);
  });
});
