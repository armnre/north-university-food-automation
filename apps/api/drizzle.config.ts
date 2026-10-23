import { defineConfig } from 'drizzle-kit';

/**
 * تنظیمات drizzle-kit — فقط برای **تولید** migration ورژن‌دار.
 * `drizzle-kit push` ممنوع است (قاعدهٔ ۸): هر تغییر دیتابیس با migration انجام می‌شود.
 *
 * تولید migration نیاز به اتصال به دیتابیس ندارد.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
