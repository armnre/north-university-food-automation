import { defineConfig } from 'vitest/config';

/**
 * تست‌های یکپارچه — روی PostgreSQL واقعی (بدون mock).
 * `npm run test:integration`
 *
 * پایگاه داده توسط `apps/api/test/global-setup.ts` آماده می‌شود:
 *  - با `TEST_DATABASE_URL` (CI / docker compose) یا
 *  - یک PostgreSQL ۱۵ داخلی از npm (`embedded-postgres`) روی پورت آزاد.
 *
 * همهٔ فایل‌های تست در یک thread و به‌صورت متوالی اجرا می‌شوند تا
 * یک پایگاه دادهٔ مشترک داشته باشند و تست‌های هم‌زمانی (race) قابل اتکا بمانند.
 */
export default defineConfig({
  test: {
    globalSetup: ['./apps/api/test/global-setup.ts'],
    include: ['apps/api/test/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    reporters: ['default'],
  },
});
