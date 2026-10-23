import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { rawSql } from '../../src/db/raw.js';

/**
 * دسترسی تست‌ها به پایگاه دادهٔ واقعی.
 * آدرس از `TEST_DATABASE_URL` یا از فایل `.tmp/test-db.json` (ساخته‌شده توسط
 * global-setup) خوانده می‌شود.
 */

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = resolve(here, '../../../../.tmp/test-db.json');

type State = { url: string; appUrl?: string; embedded: boolean; port?: number };

let cachedState: State | null = null;

function loadState(): State {
  if (cachedState) return cachedState;
  const external = process.env.TEST_DATABASE_URL?.trim();
  if (external) {
    cachedState = { url: external, embedded: false };
    return cachedState;
  }
  if (!existsSync(stateFile)) {
    throw new Error('پایگاه دادهٔ تست آماده نیست؛ `npm run test:integration` را اجرا کنید تا global-setup آن را بسازد.');
  }
  cachedState = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  return cachedState;
}

export function testDatabaseUrl(): string {
  return loadState().url;
}

/** آدرس اتصال با نقش اجرایی `food_app` — برای تست واقعی GRANT/REVOKE. */
export function testAppRoleDatabaseUrl(): string {
  const state = loadState();
  if (state.appUrl) return state.appUrl;
  const url = process.env.TEST_APP_ROLE_DATABASE_URL;
  if (!url) throw new Error('آدرس نقش food_app در دسترس نیست (TEST_APP_ROLE_DATABASE_URL را تنظیم کنید).');
  return url;
}

let pool: pg.Pool | null = null;
let db: Db | null = null;

/** pool مشترک تست‌های یک فایل. */
export function getTestDb(): Db {
  if (!db) {
    pool = createPool(testDatabaseUrl(), 12, 'food-test');
    db = createDb(pool);
  }
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/** client مستقل — برای تست هم‌زمانی، نقش متفاوت یا تراکنش موازی. */
export async function openClient(connectionString = testDatabaseUrl()): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, application_name: 'food-test-client' });
  await client.connect();
  return client;
}

type QueryResult<T> = { rows: T[]; rowCount: number | null };

/** اجرای SQL خام و گرفتن ردیف‌ها. */
export async function query<T = Record<string, unknown>>(target: Db, statement: string, params: unknown[] = []): Promise<T[]> {
  const result = (await target.execute(rawSql(statement, params))) as unknown as QueryResult<T>;
  return result.rows ?? [];
}

/**
 * پاک‌سازی کامل دیتابیس بین تست‌ها.
 * TRUNCATE از triggerهای «ممنوعیت حذف فیزیکی» عبور می‌کند (TRUNCATE ≠ DELETE)،
 * بنابراین دادهٔ تست پاک می‌شود بدون اینکه قیدهای تولیدی نقض شوند.
 */
export async function resetDatabase(target: Db = getTestDb()): Promise<void> {
  const rows = await query<{ tablename: string }>(
    target,
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'`,
  );
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await query(target, `TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}
