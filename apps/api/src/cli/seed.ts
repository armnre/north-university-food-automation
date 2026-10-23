#!/usr/bin/env tsx
import process from 'node:process';
import { getEnv, readEnv } from '../config/env.js';
import { createDb, createPool } from '../db/client.js';
import { seedProduction } from '../db/seed.js';

/**
 * `npm run db:seed`
 *
 * seed **تولیدی** و idempotent: وعده‌های پیش‌فرض، تنظیمات پیش‌فرض و یک سلف مرکزی.
 * هیچ دادهٔ نمونه/دمو در production نوشته نمی‌شود.
 *
 * دادهٔ دمو فقط با `NODE_ENV=development` و `ALLOW_DEMO_SEED=true` و پرچم `--demo`
 * نوشته می‌شود (برای توسعهٔ محلی).
 */
const envCheck = readEnv();
if (!envCheck.ok) {
  console.error(`پیکربندی محیط نامعتبر است:\n- ${envCheck.issues.join('\n- ')}`);
  process.exit(1);
}
const env = getEnv();
const pool = createPool(env.DATABASE_URL, 2, 'food-seed');
const db = createDb(pool);

try {
  const result = await seedProduction(db);
  console.log('seed تولیدی انجام شد:', JSON.stringify(result));

  const wantsDemo = process.argv.includes('--demo');
  if (wantsDemo) {
    if (env.NODE_ENV !== 'development' || !env.ALLOW_DEMO_SEED) {
      console.error('دادهٔ دمو فقط در NODE_ENV=development و ALLOW_DEMO_SEED=true مجاز است.');
      process.exitCode = 1;
    } else {
      const { seedDemo } = await import('../db/seed-demo.js');
      const demo = await seedDemo(db);
      console.log('seed دمو انجام شد:', JSON.stringify(demo));
    }
  }
} catch (error) {
  console.error('seed ناموفق بود:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
