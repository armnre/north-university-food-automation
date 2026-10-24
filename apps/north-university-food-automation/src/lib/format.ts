const fa = new Intl.NumberFormat('fa-IR');
export const faNum = (n: number | string | null | undefined) => (n == null || n === '' ? '—' : fa.format(Number(n)));
/** All amounts are stored and transmitted as integer Rial. UI always labels the unit explicitly. */
export const rial = (n: number) => `${fa.format(n)} ریال`;
export const faDigits = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

const dateFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const shortFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', month: 'short', day: 'numeric' });
const dtFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const wdFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'short' });

/** ymd = 'YYYY-MM-DD' calendar date (Tehran). Parsed at noon UTC to avoid TZ edge shifts. */
const ymdDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
export const faDate = (ymd: string) => (ymd ? dateFmt.format(ymdDate(ymd)) : '—');
export const faShort = (ymd: string) => (ymd ? shortFmt.format(ymdDate(ymd)) : '—');
export const faWeekday = (ymd: string) => wdFmt.format(ymdDate(ymd));
export const faDateTime = (iso: string | null | undefined) => (iso ? dtFmt.format(new Date(iso)) : '—');

/** Delivery code as shown to people (internal "R-" prefix hidden). */
export const showCode = (c: string | null | undefined) => String(c ?? '').replace(/^R-/, '');
export const tehranToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
export const addDays = (ymd: string, n: number) => {
  const d = ymdDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const MEALS: Record<string, string> = { Breakfast: 'صبحانه', Lunch: 'ناهار', Dinner: 'شام' };
export const RES_STATUS: Record<string, { label: string; tone: Tone }> = {
  Reserved: { label: 'رزرو شده', tone: 'info' },
  Delivered: { label: 'تحویل شده', tone: 'success' },
  Cancelled: { label: 'لغو شده', tone: 'muted' },
  Expired: { label: 'منقضی / عدم مراجعه', tone: 'warning' },
  Rejected: { label: 'رد شده', tone: 'danger' },
};
export const LEDGER_TYPES: Record<string, string> = {
  OnlinePayment: 'پرداخت اینترنتی', MANUAL_CASH: 'شارژ/برداشت نقدی', ManualAdjust: 'تعدیل دستی', ReservationDebit: 'کسر بابت رزرو', CancelRefund: 'بازپرداخت لغو', MealCancelledRefund: 'بازپرداخت لغو وعده', SoldOutRefund: 'بازپرداخت اتمام غذا', CapacityRefund: 'بازگشت رزرو ردشده',
};
export const ROLES: Record<string, string> = {
  SuperAdmin: 'مدیر ارشد سامانه', StudentAffairs: 'معاونت دانشجویی', Contractor: 'پیمانکار تغذیه', Operator: 'اپراتور سلف', Finance: 'مسئول مالی',
};
export type Tone = 'info' | 'success' | 'muted' | 'warning' | 'danger';

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Local datetime-input value (Tehran) <-> ISO */
export const isoToLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
};
/** Interprets a 'YYYY-MM-DDTHH:mm' value as Asia/Tehran wall time (UTC+03:30, no DST since 2022). */
export const tehranLocalToIso = (v: string) => new Date(`${v}:00+03:30`).toISOString();

const FALLBACK: Record<number, string> = {
  400: 'اطلاعات واردشده معتبر نیست.', 401: 'نشست شما معتبر نیست؛ دوباره وارد شوید.', 403: 'شما به این بخش دسترسی ندارید.',
  404: 'مورد درخواستی یافت نشد.', 409: 'این مورد با اطلاعات موجود تداخل دارد.', 429: 'تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره امتحان کنید.',
};
/** Turns raw API errors like `API call failed (401): {"message":"..."}` into a clean Persian sentence. */
export function errMsg(e: unknown) {
  let m = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e ?? '');
  const status = Number(m.match(/\((\d{3})\)/)?.[1] ?? 0);
  const json = m.indexOf('{');
  if (json >= 0) {
    try { const o = JSON.parse(m.slice(json)); m = o.userFacingMessage || o.message || o.error || ''; } catch { /* keep */ }
  }
  m = m.replace(/^API call failed[^:]*:\s*/i, '').trim();
  if (!m || /^(Internal|fetch|Failed to fetch|NetworkError|Unauthorized|Forbidden|Bad Request|Not Found)/i.test(m) || /[a-z]{4,}/i.test(m) && !/[\u0600-\u06FF]/.test(m))
    return FALLBACK[status] ?? 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.';
  return m;
}

export function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // CSV injection guard
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
