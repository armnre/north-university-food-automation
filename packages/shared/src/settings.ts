import { z } from 'zod';

/**
 * تنظیمات سامانه (`system_settings`).
 * هر کلید: نوع، مقدار پیش‌فرض، بازهٔ مجاز و برچسب فارسی.
 * صفحهٔ `/settings` (فقط SuperAdmin) و سرویس `settings` در API هر دو از این جدول می‌خوانند،
 * بنابراین اعتبارسنجی و UI نمی‌توانند از هم واگرا شوند.
 */

export const SETTING_KEYS = [
  'student_cancellation_enabled',
  'cancel_cutoff_hours',
  'noshow_grace_minutes',
  'noshow_refund',
  'scan_window_before_minutes',
  'scan_window_after_minutes',
  'min_gateway_payable_rial',
  'max_manual_adjust_rial',
  'online_payment_enabled',
  'reminder_hours_before_meal',
  'supportText',
  'helpText',
  'reservationPolicyNote',
  'cancellationPolicyNote',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export type SettingKind = 'int' | 'bool' | 'text';

export type SettingMeta = {
  key: SettingKey;
  kind: SettingKind;
  labelFa: string;
  descriptionFa: string;
  /** برای int: بازهٔ مجاز. */
  min?: number;
  max?: number;
  /** برای int: واحد نمایشی (ریال/تومان/ساعت/دقیقه). */
  unit?: 'rial' | 'hours' | 'minutes';
  defaultValue: string;
};

export const SETTINGS_META: Record<SettingKey, SettingMeta> = {
  student_cancellation_enabled: {
    key: 'student_cancellation_enabled',
    kind: 'bool',
    labelFa: 'امکان لغو رزرو توسط دانشجو',
    descriptionFa: 'در نسخهٔ اول خاموش است (فقط لغو اداری فعال است). با روشن کردن و فعال‌سازی مسیر API، لغو توسط دانشجو فعال می‌شود.',
    defaultValue: 'false',
  },
  cancel_cutoff_hours: {
    key: 'cancel_cutoff_hours',
    kind: 'int',
    labelFa: 'مهلت لغو رزرو (ساعت قبل از شروع وعده)',
    descriptionFa: 'اگر وعده «مهلت لغو» اختصاصی نداشته باشد، لغو تا این تعداد ساعت قبل از شروع وعده ممکن است.',
    min: 0,
    max: 72,
    unit: 'hours',
    defaultValue: '12',
  },
  noshow_grace_minutes: {
    key: 'noshow_grace_minutes',
    kind: 'int',
    labelFa: 'فرجهٔ عدم مراجعه (دقیقه بعد از پایان وعده)',
    descriptionFa: 'پس از پایان وعده به‌اضافهٔ این فرجه، رزرو تحویل‌نشده به «عدم مراجعه» تغییر وضعیت می‌دهد.',
    min: 0,
    max: 720,
    unit: 'minutes',
    defaultValue: '30',
  },
  noshow_refund: {
    key: 'noshow_refund',
    kind: 'bool',
    labelFa: 'بازگشت وجه در صورت عدم مراجعه',
    descriptionFa: 'پیش‌فرض خاموش است (عدم مراجعه بازپرداختی ندارد). اگر روشن شود، مبلغ رزرو عدم مراجعه به اعتبار داخلی بازمی‌گردد.',
    defaultValue: 'false',
  },
  scan_window_before_minutes: {
    key: 'scan_window_before_minutes',
    kind: 'int',
    labelFa: 'شروع بازهٔ اسکن (دقیقه قبل از شروع وعده)',
    descriptionFa: 'اسکن QR از این تعداد دقیقه قبل از شروع وعده مجاز است.',
    min: 0,
    max: 720,
    unit: 'minutes',
    defaultValue: '60',
  },
  scan_window_after_minutes: {
    key: 'scan_window_after_minutes',
    kind: 'int',
    labelFa: 'پایان بازهٔ اسکن (دقیقه بعد از پایان وعده)',
    descriptionFa: 'اسکن QR تا این تعداد دقیقه بعد از پایان وعده مجاز است.',
    min: 0,
    max: 720,
    unit: 'minutes',
    defaultValue: '60',
  },
  min_gateway_payable_rial: {
    key: 'min_gateway_payable_rial',
    kind: 'int',
    labelFa: 'حداقل مبلغ قابل پرداخت درگاه',
    descriptionFa: 'کمترین مبلغ مجاز برای ارسال به درگاه پرداخت زرین‌پال (ریال؛ حداقل درگاه ۱۰٬۰۰۰ ریال است).',
    min: 10_000,
    max: 1_000_000,
    unit: 'rial',
    defaultValue: '10000',
  },
  max_manual_adjust_rial: {
    key: 'max_manual_adjust_rial',
    kind: 'int',
    labelFa: 'سقف شارژ/برداشت دستی توسط امور مالی',
    descriptionFa: 'بیشترین مبلغ مجاز در هر تراکنش دستی (ریال).',
    min: 100_000,
    max: 5_000_000_000,
    unit: 'rial',
    defaultValue: '20000000',
  },
  online_payment_enabled: {
    key: 'online_payment_enabled',
    kind: 'bool',
    labelFa: 'پرداخت اینترنتی فعال است',
    descriptionFa: 'اگر خاموش باشد، پرداخت مستقیم از درگاه غیرفعال است و پیام راهنما نمایش داده می‌شود.',
    defaultValue: 'false',
  },
  reminder_hours_before_meal: {
    key: 'reminder_hours_before_meal',
    kind: 'int',
    labelFa: 'یادآوری وعده (ساعت قبل از شروع)',
    descriptionFa: 'یادآوری رزرو چند ساعت قبل از شروع وعده ارسال می‌شود. صفر یعنی غیرفعال.',
    min: 0,
    max: 48,
    unit: 'hours',
    defaultValue: '2',
  },
  supportText: {
    key: 'supportText',
    kind: 'text',
    labelFa: 'متن پشتیبانی',
    descriptionFa: 'در صفحهٔ اعلان‌ها و راهنمای دانشجو نمایش داده می‌شود.',
    defaultValue: '',
  },
  helpText: {
    key: 'helpText',
    kind: 'text',
    labelFa: 'متن راهنما',
    descriptionFa: 'راهنمای کوتاه استفاده از سامانه برای دانشجویان و کارمندان.',
    defaultValue: '',
  },
  reservationPolicyNote: {
    key: 'reservationPolicyNote',
    kind: 'text',
    labelFa: 'یادداشت سیاست رزرو',
    descriptionFa: 'در صفحهٔ منو و سبد خرید نمایش داده می‌شود.',
    defaultValue: '',
  },
  cancellationPolicyNote: {
    key: 'cancellationPolicyNote',
    kind: 'text',
    labelFa: 'یادداشت سیاست لغو',
    descriptionFa: 'شامل سیاست بازگشت وجه و وضعیت «عدم مراجعه» (بدون بازگشت وجه).',
    defaultValue: '',
  },
};

/** مقدار پیش‌فرض همهٔ تنظیمات (برای seed تولیدی). */
export const DEFAULT_SETTINGS: Record<SettingKey, string> = Object.fromEntries(
  Object.values(SETTINGS_META).map((m) => [m.key, m.defaultValue]),
) as Record<SettingKey, string>;

export const INT_SETTING_KEYS = SETTING_KEYS.filter((k) => SETTINGS_META[k].kind === 'int') as SettingKey[];
export const BOOL_SETTING_KEYS = SETTING_KEYS.filter((k) => SETTINGS_META[k].kind === 'bool') as SettingKey[];
export const TEXT_SETTING_KEYS = SETTING_KEYS.filter((k) => SETTINGS_META[k].kind === 'text') as SettingKey[];

export const settingKeySchema = z.enum(SETTING_KEYS);

/** اعتبارسنجی یک مقدار تنظیم با بازهٔ مجاز آن کلید. */
export function validateSettingValue(key: SettingKey, raw: unknown): { ok: true; value: string } | { ok: false; messageFa: string } {
  const meta = SETTINGS_META[key];
  if (!meta) return { ok: false, messageFa: 'کلید تنظیم نامعتبر است.' };
  const str = String(raw ?? '').trim();
  if (meta.kind === 'bool') {
    if (!['true', 'false', '1', '0'].includes(str.toLowerCase()))
      return { ok: false, messageFa: `«${meta.labelFa}» باید روشن یا خاموش باشد.` };
    return { ok: true, value: ['true', '1'].includes(str.toLowerCase()) ? 'true' : 'false' };
  }
  if (meta.kind === 'text') {
    if (str.length > 3000) return { ok: false, messageFa: `«${meta.labelFa}» حداکثر ۳۰۰۰ کاراکتر است.` };
    return { ok: true, value: str };
  }
  if (!/^-?\d{1,15}$/.test(str)) return { ok: false, messageFa: `«${meta.labelFa}» باید عدد صحیح باشد.` };
  const n = Number(str);
  if (!Number.isSafeInteger(n)) return { ok: false, messageFa: `«${meta.labelFa}» خارج از بازهٔ مجاز است.` };
  if (meta.min !== undefined && n < meta.min) return { ok: false, messageFa: `«${meta.labelFa}» نباید کمتر از ${meta.min} باشد.` };
  if (meta.max !== undefined && n > meta.max) return { ok: false, messageFa: `«${meta.labelFa}» نباید بیشتر از ${meta.max} باشد.` };
  return { ok: true, value: String(n) };
}

/** مقدارهای تایپ‌شدهٔ تنظیمات (پس از خواندن از دیتابیس). */
export type ResolvedSettings = {
  studentCancellationEnabled: boolean;
  cancelCutoffHours: number;
  noshowGraceMinutes: number;
  noShowRefund: boolean;
  scanWindowBeforeMinutes: number;
  scanWindowAfterMinutes: number;
  minGatewayPayableRial: number;
  maxManualAdjustRial: number;
  onlinePaymentEnabled: boolean;
  reminderHoursBeforeMeal: number;
  supportText: string;
  helpText: string;
  reservationPolicyNote: string;
  cancellationPolicyNote: string;
};

const toInt = (v: string | undefined, fallback: string): number => {
  const n = Number(String(v ?? fallback).trim());
  return Number.isSafeInteger(n) ? n : Number(fallback);
};
const toBool = (v: string | undefined, fallback: string): boolean => {
  const s = String(v ?? fallback)
    .trim()
    .toLowerCase();
  return s === 'true' || s === '1';
};

/** تبدیل ردیف‌های خام `system_settings` به ساختار تایپ‌شده با مقدارهای پیش‌فرض. */
export function resolveSettings(rows: Partial<Record<SettingKey, string | null | undefined>>): ResolvedSettings {
  const get = (k: SettingKey): string => {
    const v = rows[k];
    return v == null || v === '' ? DEFAULT_SETTINGS[k] : String(v);
  };
  return {
    studentCancellationEnabled: toBool(get('student_cancellation_enabled'), DEFAULT_SETTINGS.student_cancellation_enabled),
    cancelCutoffHours: toInt(get('cancel_cutoff_hours'), DEFAULT_SETTINGS.cancel_cutoff_hours),
    noshowGraceMinutes: toInt(get('noshow_grace_minutes'), DEFAULT_SETTINGS.noshow_grace_minutes),
    noShowRefund: toBool(get('noshow_refund'), DEFAULT_SETTINGS.noshow_refund),
    scanWindowBeforeMinutes: toInt(get('scan_window_before_minutes'), DEFAULT_SETTINGS.scan_window_before_minutes),
    scanWindowAfterMinutes: toInt(get('scan_window_after_minutes'), DEFAULT_SETTINGS.scan_window_after_minutes),
    minGatewayPayableRial: toInt(get('min_gateway_payable_rial'), DEFAULT_SETTINGS.min_gateway_payable_rial),
    maxManualAdjustRial: toInt(get('max_manual_adjust_rial'), DEFAULT_SETTINGS.max_manual_adjust_rial),
    onlinePaymentEnabled: toBool(get('online_payment_enabled'), DEFAULT_SETTINGS.online_payment_enabled),
    reminderHoursBeforeMeal: toInt(get('reminder_hours_before_meal'), DEFAULT_SETTINGS.reminder_hours_before_meal),
    supportText: get('supportText'),
    helpText: get('helpText'),
    reservationPolicyNote: get('reservationPolicyNote'),
    cancellationPolicyNote: get('cancellationPolicyNote'),
  };
}
