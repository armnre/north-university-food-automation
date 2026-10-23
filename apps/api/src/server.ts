import { sql } from 'drizzle-orm';
import { getEnv, readEnv } from './config/env.js';
import { buildApp } from './app.js';
import { closeDb, getDb } from './db/client.js';
import { appliedMigrationCount, listMigrations } from './db/migrate.js';
import { seedProduction } from './db/seed.js';
import { createLogger } from './lib/logger.js';

/**
 * راه‌اندازی سرور API.
 *
 * fail-fast:
 *  ۱. اگر متغیرهای محیطی نامعتبر/ناقص باشند، اپ بالا نمی‌آید.
 *  ۲. اگر اتصال به دیتابیس برقرار نشود، اپ بالا نمی‌آید.
 *  ۳. اگر migrationها کامل اعمال نشده باشند، اپ بالا نمی‌آید
 *     (ابتدا `npm run db:migrate` را اجرا کنید).
 */
async function main(): Promise<void> {
  const envCheck = readEnv();
  if (!envCheck.ok) {
    console.error(`پیکربندی محیط نامعتبر است:\n- ${envCheck.issues.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  const env = getEnv();
  const logger = createLogger(env, 'food-api');

  const app = await buildApp({ env, logger });

  try {
    await app.ready();
  } catch (error) {
    logger.fatal({ err: error }, 'آماده‌سازی اپلیکیشن ناموفق بود');
    process.exitCode = 1;
    return;
  }

  // بررسی اتصال و مهاجرت‌ها پیش از پذیرش ترافیک
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    logger.fatal({ err: error }, 'اتصال به پایگاه داده برقرار نشد');
    process.exitCode = 1;
    await app.close();
    return;
  }

  const available = listMigrations().length;
  let applied: number;
  try {
    applied = await appliedMigrationCount(env.DATABASE_URL);
  } catch (error) {
    logger.fatal({ err: error }, 'بررسی وضعیت مهاجرت‌ها ناموفق بود');
    process.exitCode = 1;
    await app.close();
    return;
  }
  if (applied < available) {
    logger.fatal({ applied, available }, 'مهاجرت‌های پایگاه داده کامل نیستند؛ ابتدا `npm run db:migrate` را اجرا کنید.');
    process.exitCode = 1;
    await app.close();
    return;
  }

  // seed ساختاری (idempotent): وعده‌ها، تنظیمات پیش‌فرض و سلف مرکزی
  try {
    const result = await seedProduction(getDb());
    logger.info({ ...result }, 'seed تولیدی بررسی/اعمال شد');
  } catch (error) {
    logger.error({ err: error }, 'seed تولیدی ناموفق بود (ادامهٔ سرویس ممکن است)');
  }

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV, applied, available }, 'سرور API آماده است');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'در حال خاموش کردن سرویس…');
    try {
      await app.close();
      await closeDb();
      process.exitCode = 0;
    } catch (error) {
      logger.error({ err: error }, 'خاموش کردن سرویس با خطا مواجه شد');
      process.exitCode = 1;
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.fatal({ err: reason }, 'unhandledRejection'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
}

void main();
