import { sql } from 'drizzle-orm';
import { getEnv, readEnv } from './config/env.js';
import { createDb, createPool } from './db/client.js';
import { appliedMigrationCount, listMigrations } from './db/migrate.js';
import { createLogger } from './lib/logger.js';
import { makeWorkerId, runAllWorkerJobsOnce, startWorkerScheduler } from './services/worker-jobs.js';
import type { ServiceDeps } from './types.js';

/**
 * پروسهٔ مستقل `food-worker` (جدا از `food-api`).
 *
 * حالت‌ها:
 *  - پیش‌فرض: اجرای زمان‌بند دائمی تحت systemd (`food-worker.service`).
 *  - `--once` : اجرای یک‌بارهٔ همهٔ jobها و خروج تمیز (مناسب تست دود و عیب‌یابی).
 */
async function main(): Promise<void> {
  const envCheck = readEnv();
  if (!envCheck.ok) {
    console.error(`پیکربندی محیط worker نامعتبر است:\n- ${envCheck.issues.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }

  const env = getEnv();
  const logger = createLogger(env, 'food-worker');
  const workerId = makeWorkerId('food-worker');
  const pool = createPool(env.DATABASE_URL, Math.min(env.DATABASE_POOL_MAX, 5), 'food-worker');
  const db = createDb(pool);
  const deps: ServiceDeps = { db, env, log: logger };

  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    logger.fatal({ err: error }, 'اتصال worker به پایگاه داده برقرار نشد');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const available = listMigrations().length;
  try {
    const applied = await appliedMigrationCount(env.DATABASE_URL);
    if (applied < available) {
      logger.fatal({ applied, available }, 'مهاجرت‌های پایگاه داده کامل نیستند؛ worker متوقف شد');
      process.exitCode = 1;
      await pool.end();
      return;
    }
  } catch (error) {
    logger.fatal({ err: error }, 'بررسی وضعیت مهاجرت‌ها در worker ناموفق بود');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const runOnce = process.argv.includes('--once');
  if (runOnce) {
    logger.info({ workerId }, 'اجرای یک‌بارهٔ همهٔ jobهای worker شروع شد');
    const results = await runAllWorkerJobsOnce(pool, deps, workerId);
    const failed = results.filter((r) => r.status === 'Failed').length;
    logger.info({ workerId, results }, 'اجرای یک‌بارهٔ worker به پایان رسید');
    await pool.end();
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  logger.info({ workerId, timezone: 'Asia/Tehran' }, 'سرویس زمان‌بند food-worker آماده به کار شد');
  const handle = startWorkerScheduler(pool, deps, workerId);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, workerId }, 'در حال توقف امن سرویس food-worker…');
    try {
      await handle.stop();
      await pool.end();
      process.exitCode = 0;
    } catch (error) {
      logger.error({ err: error, workerId }, 'خطا هنگام بستن سرویس food-worker');
      process.exitCode = 1;
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.fatal({ err: reason, workerId }, 'unhandledRejection در worker'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error, workerId }, 'uncaughtException در worker');
    void shutdown('uncaughtException');
  });
}

void main();
