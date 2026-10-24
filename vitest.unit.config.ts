import { defineConfig } from 'vitest/config';

/**
 * تست‌های واحد — بدون دیتابیس.
 * `npm run test`
 */
export default defineConfig({
  test: {
    include: ['apps/api/test/unit/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'packages/shared/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    pool: 'threads',
    testTimeout: 30_000,
    reporters: ['default'],
  },
});
