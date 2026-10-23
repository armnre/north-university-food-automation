/**
 * کدهای خطای سامانه و پیام‌های فارسی پیش‌فرض.
 *
 * قواعد:
 *  - پیام همیشه فارسی، روشن و بدون افشای جزئیات فنی است.
 *  - پیام هیچ‌گاه وجود/عدم وجود حساب را لو نمی‌دهد (ورود دانشجو/کارکنان).
 *  - کد خطا برای منطق فرانت‌اند است (مثلاً `CAPTCHA_REQUIRED`)، نه برای نمایش.
 */
export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE_OFFERING',
  'CAPACITY_FULL',
  'INSUFFICIENT_BALANCE',
  'PAYMENT_REQUIRED',
  'ACCOUNT_INACTIVE',
  'TOO_MANY_REQUESTS',
  'LOCKED',
  'CAPTCHA_REQUIRED',
  'CAPTCHA_INVALID',
  'DEADLINE_PASSED',
  'OUTSIDE_SCAN_WINDOW',
  'WRONG_CAFETERIA',
  'ALREADY_DELIVERED',
  'IDEMPOTENCY_CONFLICT',
  'PAYMENT_GATEWAY_DISABLED',
  'PAYMENT_NEEDS_REVIEW',
  'SETTINGS_INVALID',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_OFFERING: 409,
  CAPACITY_FULL: 409,
  INSUFFICIENT_BALANCE: 402,
  PAYMENT_REQUIRED: 402,
  ACCOUNT_INACTIVE: 403,
  TOO_MANY_REQUESTS: 429,
  LOCKED: 423,
  CAPTCHA_REQUIRED: 428,
  CAPTCHA_INVALID: 400,
  DEADLINE_PASSED: 409,
  OUTSIDE_SCAN_WINDOW: 409,
  WRONG_CAFETERIA: 403,
  ALREADY_DELIVERED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PAYMENT_GATEWAY_DISABLED: 409,
  PAYMENT_NEEDS_REVIEW: 500,
  SETTINGS_INVALID: 400,
  INTERNAL: 500,
};

export const ERROR_MESSAGES_FA: Record<ErrorCode, string> = {
  VALIDATION: 'اطلاعات واردشده معتبر نیست.',
  UNAUTHORIZED: 'برای این کار باید وارد سامانه شوید.',
  SESSION_EXPIRED: 'نشست شما منقضی شده است. دوباره وارد شوید.',
  FORBIDDEN: 'شما مجوز انجام این عملیات را ندارید.',
  NOT_FOUND: 'مورد درخواستی یافت نشد.',
  CONFLICT: 'این درخواست با وضعیت فعلی سامانه تداخل دارد.',
  DUPLICATE_OFFERING: 'این غذا را قبلاً رزرو کرده‌اید.',
  CAPACITY_FULL: 'متأسفانه ظرفیت این وعده تکمیل شده است.',
  INSUFFICIENT_BALANCE: 'موجودی کیف پول شما کافی نیست.',
  PAYMENT_REQUIRED: 'موجودی کیف پول شما برای این رزرو کافی نیست.',
  ACCOUNT_INACTIVE: 'حساب شما فعال نیست. با معاونت دانشجویی تماس بگیرید.',
  TOO_MANY_REQUESTS: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.',
  LOCKED: 'به دلیل تلاش‌های ناموفق متعدد، ورود موقتاً مسدود شده است. چند دقیقه دیگر دوباره تلاش کنید.',
  CAPTCHA_REQUIRED: 'برای ادامه، کد امنیتی را وارد کنید.',
  CAPTCHA_INVALID: 'کد امنیتی نادرست یا منقضی است. دوباره تلاش کنید.',
  DEADLINE_PASSED: 'مهلت این عملیات به پایان رسیده است.',
  OUTSIDE_SCAN_WINDOW: 'خارج از بازهٔ زمانی تحویل این وعده هستید.',
  WRONG_CAFETERIA: 'این رزرو مربوط به سلف دیگری است.',
  ALREADY_DELIVERED: 'این وعده قبلاً تحویل شده است.',
  IDEMPOTENCY_CONFLICT: 'این درخواست قبلاً با کلید یکسان و محتوای متفاوت ثبت شده است.',
  PAYMENT_GATEWAY_DISABLED: 'پرداخت اینترنتی فعال نیست. شارژ کیف پول توسط امور مالی انجام می‌شود.',
  PAYMENT_NEEDS_REVIEW: 'پرداخت شما در حال بررسی است؛ مبلغ پس از تأیید به کیف پول اضافه می‌شود.',
  SETTINGS_INVALID: 'مقدارهای تنظیمات معتبر نیست.',
  INTERNAL: 'خطای غیرمنتظره در سامانه رخ داد. دوباره تلاش کنید.',
};

/** شکل بدنهٔ پاسخ خطا (همهٔ endpointها یکسان). */
export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    /** جزئیات غیرحساس برای نمایش (مثلاً مبلغ کسری یا زمان مهلت). */
    details?: Record<string, unknown>;
  };
};

/** پیام فارسی یک کد خطا (بدون افشای جزئیات فنی). */
export function errorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES_FA[code] ?? ERROR_MESSAGES_FA.INTERNAL;
}

/** وضعیت HTTP یک کد خطا. */
export function errorStatus(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code] ?? 500;
}
