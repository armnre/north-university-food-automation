import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { runMigrations } from '../src/db/migrate.js';

/**
 * راه‌اندازی پایگاه دادهٔ تست.
 *
 * تست‌های یکپارچه روی **PostgreSQL واقعی** اجرا می‌شوند (نه mock).
 *  - اگر `TEST_DATABASE_URL` تنظیم شده باشد (سرویس PostgreSQL در CI یا
 *    `docker compose up postgres_test`) از همان استفاده می‌شود.
 *  - در غیر این صورت یک PostgreSQL ۱۵ واقعی از بستهٔ npm `embedded-postgres`
 *    روی یک پورت آزاد راه‌اندازی می‌شود؛ بدون نیاز به Docker یا نصب سیستمی.
 *
 * آدرس پایگاه داده در `.tmp/test-db.json` نوشته می‌شود تا workerهای vitest آن را بخوانند.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const tmpDir = resolve(repoRoot, '.tmp');
export const stateFile = resolve(tmpDir, 'test-db.json');
const dataDir = resolve(tmpDir, 'pgdata-test');

const quiet = () => undefined;

async function freePort(preferred?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((res, rej) => {
      const srv = createServer();
      srv.once('error', rej);
      srv.once('listening', () => {
        const address = srv.address();
        const assigned = typeof address === 'object' && address ? address.port : port;
        srv.close(() => res(assigned));
      });
      srv.listen(port, '127.0.0.1');
    });
  if (preferred) {
    try {
      return await tryPort(preferred);
    } catch {
      /* پورت اشغال بود ⇒ پورت تصادفی */
    }
  }
  return tryPort(0);
}

export async function setup(): Promise<() => Promise<void>> {
  mkdirSync(tmpDir, { recursive: true });
  const verbose = process.env.TEST_DB_VERBOSE === '1';

  const external = process.env.TEST_DATABASE_URL?.trim();
  if (external) {
    await runMigrations({ connectionString: external, log: verbose ? (m) => process.stdout.write(`[test-db] ${m}\n`) : quiet });
    writeFileSync(stateFile, JSON.stringify({ url: external, embedded: false }), 'utf8');
    process.stdout.write(`[test-db] استفاده از پایگاه دادهٔ خارجی ${external.replace(/:[^:@/]+@/, ':***@')}\n`);
    return async () => {
      rmSync(stateFile, { force: true });
    };
  }

  const port = await freePort(Number(process.env.TEST_PG_PORT ?? 0) || undefined);
  rmSync(dataDir, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'food_test',
    password: 'food_test_password',
    port,
    persistent: false,
    authMethod: 'password',
    // encoding باید UTF-8 باشد تا طول/مقایسهٔ متن فارسی درست کار کند
    initdbFlags: ['--encoding=UTF8', '--locale=C.UTF-8'],
    postgresFlags: ['-c', 'log_min_messages=warning'],
    onLog: verbose ? (m) => process.stdout.write(m) : quiet,
    onError: (m) => process.stderr.write(String(m instanceof Error ? m.message : m)),
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('food_test');

  const url = `postgres://food_test:food_test_password@127.0.0.1:${port}/food_test`;
  await runMigrations({ connectionString: url, log: verbose ? (m) => process.stdout.write(`[test-db] ${m}\n`) : quiet });

  // نقش اجرایی برای تست واقعی GRANT/REVOKE (دسترسی فقط از localhost)
  const admin = await pg.getPgClient('food_test');
  await admin.connect();
  await admin.query(`ALTER ROLE food_app WITH LOGIN PASSWORD 'food_app_test'`);
  await admin.query(`ALTER ROLE food_migrator WITH LOGIN PASSWORD 'food_migrator_test'`);
  await admin.query(`GRANT CONNECT ON DATABASE food_test TO food_app`);
  await admin.query(`GRANT CONNECT ON DATABASE food_test TO food_migrator`);
  await admin.end();

  writeFileSync(
    stateFile,
    JSON.stringify({ url, embedded: true, port, appUrl: url.replace('food_test:food_test_password', 'food_app:food_app_test') }),
    'utf8',
  );
  process.stdout.write(`[test-db] PostgreSQL ۱۵ داخلی روی پورت ${port} آماده شد.\n`);

  return async () => {
    try {
      await pg.stop();
    } catch (error) {
      process.stderr.write(`[test-db] توقف PostgreSQL ناموفق بود: ${String(error)}\n`);
    }
    rmSync(stateFile, { force: true });
    rmSync(dataDir, { recursive: true, force: true });
  };
}

export { repoRoot };
