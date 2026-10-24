import type { Tone } from './format';

export const STUDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  Active: { label: 'فعال', tone: 'success' },
  Inactive: { label: 'غیرفعال', tone: 'muted' },
  OnLeave: { label: 'غیرفعال / مرخصی', tone: 'muted' },
  Withdrawn: { label: 'انصراف', tone: 'warning' },
  Graduated: { label: 'فارغ‌التحصیل', tone: 'info' },
  Removed: { label: 'حذف از فهرست', tone: 'danger' },
};
