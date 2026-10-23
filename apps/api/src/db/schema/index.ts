/**
 * اسکیمای کامل پایگاه داده (Drizzle ORM).
 *
 * قواعد:
 *  - همهٔ جدول‌ها `id` UUID و `created_at`/`updated_at` دارند.
 *  - حذف فیزیکی رکوردهای مالی، ممیزی، دانشجو، رزرو و غذا ممنوع است (trigger در migration `0001`).
 *  - مبالغ ریال و عدد صحیح (`bigint`).
 *  - زمان‌ها UTC ذخیره و در لایهٔ نمایش به تهران/شمسی تبدیل می‌شوند.
 */
export * from './base.js';
export * from './identity.js';
export * from './catalog.js';
export * from './reservations.js';
export * from './finance.js';
export * from './system.js';
