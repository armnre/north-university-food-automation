import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';
import { getEnv } from '../config/env.js';

export type Db = NodePgDatabase<typeof schema>;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * ساخت pool اتصال PostgreSQL.
 *
 * نکتهٔ امنیتی: `application_name` برای تشخیص اتصال برنامه در `pg_stat_activity`
 * و `max` محدود برای جلوگیری از اشباع اتصالات سرور دانشگاه.
 */
export function createPool(connectionString: string, max = 10, applicationName = 'food-api'): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    application_name: applicationName,
    // در سرور دانشگاه، PostgreSQL محلی و بدون TLS است؛ اگر URL پارامتر ssl داشته باشد،
    // خود pg آن را اعمال می‌کند.
  });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema, logger: false });
}

let singletonPool: pg.Pool | null = null;
let singletonDb: Db | null = null;

/** pool و db مشترک فرآیند (با نقش اجرایی `food_app`). */
export function getDb(): Db {
  if (!singletonDb) {
    const env = getEnv();
    singletonPool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX, 'food-api');
    singletonDb = createDb(singletonPool);
  }
  return singletonDb;
}

export function getPool(): pg.Pool {
  getDb();
  return singletonPool as pg.Pool;
}

export async function closeDb(): Promise<void> {
  if (singletonPool) {
    await singletonPool.end();
    singletonPool = null;
    singletonDb = null;
  }
}

/**
 * اجرای یک تابع در تراکنش.
 * همهٔ منطق مالی/هم‌زمانی باید از این مسیر برود تا «همه یا هیچ» تضمین شود.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
