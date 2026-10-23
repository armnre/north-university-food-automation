import { boolean, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * ستون‌های مشترک همهٔ جدول‌ها.
 *  - `id`: UUID (`gen_random_uuid()` داخلی PostgreSQL 15+)
 *  - `created_at` / `updated_at`: `timestamptz` — ذخیره UTC، نمایش به وقت تهران
 * `updated_at` با trigger `set_updated_at` نگهداری می‌شود (نه در کد برنامه).
 */
export const id = () => uuid('id').primaryKey().defaultRandom().notNull();

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** ستون حذف نرم (به‌جای حذف فیزیکی). */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

/** ستون غیرفعال‌سازی (به‌جای حذف فیزیکی). */
export const isActive = (defaultValue = true) => boolean('is_active').notNull().default(defaultValue);

/**
 * مبالغ: ریال، عدد صحیح، نوع `bigint` در دیتابیس.
 *
 * `mode: 'number'` انتخاب شده تا JSON-سازی ساده بماند؛ سقف CHECK در هر ستون
 * مبلغ (۹e15 ریال) تضمین می‌کند مقدار همیشه داخل بازهٔ امن JavaScript بماند.
 */
export const MONEY_MAX_RIAL = 9_000_000_000_000_000;

/** قالب «روز سرویس»: `YYYY-MM-DD` = روز تقویمی تهران. */
export const SERVICE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
