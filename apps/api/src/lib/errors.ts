import { ERROR_HTTP_STATUS, ERROR_MESSAGES_FA, type ErrorCode } from '@food/shared';

/**
 * خطای دامنه‌ای سامانه.
 * پیام همیشه فارسی و قابل نمایش به کاربر است؛ جزئیات فنی هرگز نشت نمی‌کنند.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>, status?: number) {
    super(message ?? ERROR_MESSAGES_FA[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ERROR_HTTP_STATUS[code] ?? 500;
    this.details = details;
  }
}

/** پرتاب خطای دامنه‌ای با پیام فارسی. */
export function fail(code: ErrorCode, message?: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, details);
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * متن کامل خطای دیتابیس شامل زنجیرهٔ `cause`.
 * درایور Drizzle پیام اصلی PostgreSQL را در `cause` می‌گذارد، بنابراین برای
 * تشخیص نقض قیدها (مثل ایندکس یکتای جزئی) باید هر دو بررسی شوند.
 */
export function dbErrorText(error: unknown): string {
  const parts: string[] = [];
  let current = error as { message?: unknown; cause?: unknown } | null | undefined;
  let depth = 0;
  while (current && depth < 6) {
    if (typeof current.message === 'string') parts.push(current.message);
    current = current.cause as { message?: unknown; cause?: unknown } | null | undefined;
    depth += 1;
  }
  return parts.join(' | ');
}

/** کد خطای PostgreSQL (مثل `23505` برای نقض یکتایی) از زنجیرهٔ cause. */
export function pgErrorCode(error: unknown): string {
  let current = error as { code?: unknown; cause?: unknown } | null | undefined;
  let depth = 0;
  while (current && depth < 6) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = current.cause as { code?: unknown; cause?: unknown } | null | undefined;
    depth += 1;
  }
  return '';
}

/** تبدیل خطای ناشناخته به پاسخ امن (بدون افشای جزئیات داخلی). */
export function toSafeError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    // نقض قید یکتایی ⇒ پیام دامنه‌ای، نه جزئیات SQL
    const message = dbErrorText(error);
    if (/duplicate key value violates unique constraint/.test(message)) {
      const constraint = message.match(/"([a-z0-9_]+)"[\s\S]*?Key \(/i)?.[1] ?? '';
      return new AppError('CONFLICT', undefined, { constraint });
    }
    if (/violates check constraint/.test(message)) {
      return new AppError('VALIDATION', 'اطلاعات واردشده با قوانین سامانه سازگار نیست.');
    }
    if (/violates foreign key constraint/.test(message)) {
      return new AppError('NOT_FOUND', 'مورد ارجاع‌شده وجود ندارد.');
    }
    if (/permission denied/.test(message)) {
      return new AppError('FORBIDDEN', 'این عملیات در سطح پایگاه داده مجاز نیست.');
    }
  }
  return new AppError('INTERNAL');
}
