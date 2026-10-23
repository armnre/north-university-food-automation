/**
 * زمان در سامانه:
 *  - ذخیره: UTC (ستون‌های `timestamptz`)
 *  - منطقهٔ عملیاتی: `Asia/Tehran`
 *  - «روز سرویس»: نوع `date` = روز تقویمی تهران
 *  - نمایش: شمسی
 *
 * ایران از سال ۲۰۲۲ ساعت تابستانی ندارد، بنابراین اختلاف ثابت +03:30 است.
 * با این حال همهٔ تبدیل‌ها از `Intl` با منطقهٔ `Asia/Tehran` انجام می‌شود تا
 * در صورت تغییر قوانین، نیاز به تغییر کد نباشد (تست واحد این فرض را بررسی می‌کند).
 */
import { toPersianDigits } from './normalize.js';

export const TEHRAN_TZ = 'Asia/Tehran';
export const TEHRAN_OFFSET_MINUTES = 210; // +03:30

export type TehranParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEHRAN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** اجزای یک لحظه به وقت تهران. */
export function tehranParts(date: Date = new Date()): TehranParts {
  const p = partsFmt.formatToParts(date);
  const g = (t: string): number => Number(p.find((x) => x.type === t)?.value ?? '0');
  const hour = g('hour') === 24 ? 0 : g('hour');
  return { year: g('year'), month: g('month'), day: g('day'), hour, minute: g('minute'), second: g('second') };
}

/** روز سرویس = روز تقویمی تهران به شکل `YYYY-MM-DD`. */
export function tehranToday(now: Date = new Date()): string {
  const p = tehranParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DDTHH:mm:ss` به وقت تهران (بدون اختلاف منطقه). */
export function tehranLocalIso(date: Date = new Date()): string {
  const p = tehranParts(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** افزودن/کم کردن روز به یک روز سرویس (`YYYY-MM-DD`) بدون جابه‌جایی منطقهٔ زمانی. */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** افزودن دقیقه به یک لحظه. */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

/**
 * ترکیب «روز سرویس» با «ساعت دیواری تهران» → لحظهٔ UTC.
 * `time` می‌تواند `HH:mm` یا `HH:mm:ss` باشد.
 */
export function tehranDateTimeToUtc(serviceDate: string, time: string, now: Date = new Date()): Date {
  const parts = time.split(':');
  const h = Number(parts[0] ?? '0');
  const m = Number(parts[1] ?? '0');
  const s = Number(parts[2] ?? '0');
  const offsetMinutes = tehranOffsetMinutes(now);
  const utcMs = Date.parse(`${serviceDate}T00:00:00.000Z`) + (h * 3600 + m * 60 + s) * 1000 - offsetMinutes * 60_000;
  return new Date(utcMs);
}

/** اختلاف تهران با UTC در یک لحظهٔ مشخص (دقیقه). */
export function tehranOffsetMinutes(now: Date = new Date()): number {
  const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const teh = new Date(now.toLocaleString('en-US', { timeZone: TEHRAN_TZ }));
  return Math.round((teh.getTime() - utc.getTime()) / 60_000);
}

const faDateFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TEHRAN_TZ, year: 'numeric', month: 'long', day: 'numeric' });
const faDateTimeFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TEHRAN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const faTimeFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TEHRAN_TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** نمایش شمسی یک روز سرویس: «۳۰ مهر ۱۴۰۴» */
export function formatFaDate(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  return faDateFmt.format(new Date(`${ymd}T12:00:00Z`));
}

/** نمایش شمسی یک لحظه: «۱۴۰۴/۰۷/۳۰، ۱۴:۲۰» — برای پیام‌های مهلت و تحویل. */
export function formatFaDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return faDateTimeFmt.format(iso instanceof Date ? iso : new Date(iso)).replace(/[,،]/, ' ساعت ');
}

/** نمایش ساعت به وقت تهران با ارقام فارسی: «۱۴:۲۰» */
export function formatFaTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return toPersianDigits(faTimeFmt.format(iso instanceof Date ? iso : new Date(iso)));
}

/** آیا `ymd` (روز سرویس) گذشته است؟ */
export function isPastServiceDate(ymd: string, now: Date = new Date()): boolean {
  return ymd < tehranToday(now);
}

export function isFutureServiceDate(ymd: string, now: Date = new Date()): boolean {
  return ymd > tehranToday(now);
}

/** قالب `YYYY-MM-DD` برای اعتبارسنجی ورودی. */
export const SERVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
