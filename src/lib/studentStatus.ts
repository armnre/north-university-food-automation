import type { Tone } from './format';

export const STUDENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  Active: { label: 'فعال', tone: 'success' },
  Inactive: { label: 'غیرفعال', tone: 'muted' },
  Removed: { label: 'حذف از فهرست', tone: 'danger' },
};
