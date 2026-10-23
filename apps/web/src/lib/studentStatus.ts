import type { Tone } from './format';

/** وضعیت‌های دانشجو مطابق اسکیمای پایگاه داده. */
export const STUDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  Active: { label: 'فعال', tone: 'success' },
  OnLeave: { label: 'مرخصی تحصیلی', tone: 'warning' },
  Withdrawn: { label: 'انصرافی', tone: 'muted' },
  Graduated: { label: 'فارغ‌التحصیل', tone: 'info' },
  Removed: { label: 'حذف از فهرست', tone: 'danger' },
};

export const STUDENT_STATUS_OPTIONS = Object.entries(STUDENT_STATUS).map(([value, meta]) => ({ value, label: meta.label }));

export const statusLabel = (status: string): string => STUDENT_STATUS[status]?.label ?? status;
