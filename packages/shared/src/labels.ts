import type { MealSlotCode } from './constants.js';

/** وعده‌های پیش‌فرض سامانه (seed تولیدی). ساعت‌ها به وقت تهران و قابل ویرایش در صفحهٔ تنظیمات. */
export type MealSlotDefault = {
  code: MealSlotCode;
  titleFa: string;
  startTime: string;
  endTime: string;
  sortOrder: number;
};

export const MEAL_SLOT_DEFAULTS: readonly MealSlotDefault[] = [
  { code: 'Breakfast', titleFa: 'صبحانه', startTime: '07:00:00', endTime: '09:00:00', sortOrder: 1 },
  { code: 'Lunch', titleFa: 'ناهار', startTime: '12:00:00', endTime: '14:30:00', sortOrder: 2 },
  { code: 'Dinner', titleFa: 'شام', startTime: '18:30:00', endTime: '21:00:00', sortOrder: 3 },
];

export const MEAL_SLOT_LABELS_FA: Record<MealSlotCode, string> = {
  Breakfast: 'صبحانه',
  Lunch: 'ناهار',
  Dinner: 'شام',
};

export function mealSlotLabel(code: string): string {
  return MEAL_SLOT_LABELS_FA[code as MealSlotCode] ?? code;
}

/** وضعیت‌های رزرو به فارسی. */
export const RESERVATION_STATUS_LABELS_FA: Record<string, string> = {
  Reserved: 'رزرو شده',
  Delivered: 'تحویل شده',
  Cancelled: 'لغو شده',
  Rejected: 'رد شده',
  Expired: 'منقضی شده',
  NoShow: 'عدم مراجعه',
};

/** وضعیت‌های آیتم منو به فارسی. */
export const OFFERING_STATUS_LABELS_FA: Record<string, string> = {
  Draft: 'پیش‌نویس',
  Published: 'منتشر شده',
  Closed: 'بسته شده',
  Cancelled: 'لغو شده',
  SoldOut: 'تمام شده',
};

/** نوع‌های دفتر کل به فارسی (نمایش در کیف پول و گزارش مالی). */
export const LEDGER_TYPE_LABELS_FA: Record<string, string> = {
  ManualCredit: 'شارژ دستی',
  ManualDebit: 'برداشت دستی',
  OnlinePayment: 'پرداخت اینترنتی',
  ReservationDebit: 'کسر بابت رزرو',
  CancellationRefund: 'بازگشت وجه لغو رزرو',
  MealUnavailableRefund: 'بازگشت وجه لغو/اتمام وعده',
  AdminRefund: 'بازگشت وجه اداری',
  WithdrawalHold: 'مسدودی بابت برداشت',
  WithdrawalPaid: 'پرداخت برداشت',
  WithdrawalRelease: 'آزادسازی مسدودی برداشت',
  Correction: 'اصلاح حساب',
};

/** حساب‌های سیستمی به فارسی. */
export const SYSTEM_ACCOUNT_LABELS_FA: Record<string, string> = {
  MEAL_REVENUE: 'درآمد غذا',
  MANUAL_CASH: 'نقدینگی دستی',
  GATEWAY_CLEARING: 'تسویهٔ درگاه پرداخت',
  WITHDRAWAL_ESCROW: 'امانی برداشت وجه',
  TREASURY: 'خزانه',
};

/** نتیجهٔ اسکن تحویل به فارسی (پیام‌های دقیق برای اپراتور سلف). */
export const DELIVERY_OUTCOME_LABELS_FA: Record<string, string> = {
  Accepted: 'تحویل شد',
  Duplicate: 'قبلاً تحویل شده',
  Invalid: 'کد نامعتبر',
  WrongDay: 'مربوط به روز دیگر',
  OutsideWindow: 'خارج از بازهٔ زمانی',
  Cancelled: 'رزرو لغو شده',
  Expired: 'منقضی شده',
  WrongCafeteria: 'سلف اشتباه',
  OfflineConflict: 'تعارض همگام‌سازی آفلاین',
};

/** وضعیت‌های وعده که ذکر دلیل برای آن‌ها الزامی است. */
export const OFFERING_STATUS_REQUIRES_REASON = ['Cancelled', 'SoldOut'] as const;

export function offeringStatusNeedsReason(status: string): boolean {
  return (OFFERING_STATUS_REQUIRES_REASON as readonly string[]).includes(status);
}
