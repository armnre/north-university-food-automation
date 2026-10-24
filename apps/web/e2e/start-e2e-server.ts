import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { buildApp } from '../../api/src/app.js';
import { readEnv, testEnv } from '../../api/src/config/env.js';
import { createDb, createPool } from '../../api/src/db/client.js';
import { runMigrations } from '../../api/src/db/migrate.js';
import { rawSql } from '../../api/src/db/raw.js';
import { createSilentLogger } from '../../api/src/lib/logger.js';
import {
  createDeliverableOffering,
  createFood,
  createOffering,
  createStaff,
  createStudent,
  makeNationalId,
  resetBaseCache,
  seedBase,
} from '../../api/test/helpers/fixtures.js';

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function main(): Promise<void> {
  const apiPort = Number(process.env.E2E_PORT ?? 3199);
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const pepper = 'e2e-national-id-pepper-0123456789abcdef0123456789';

  let embeddedPg: EmbeddedPostgres | null = null;
  let pgDataDir = '';
  let databaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';

  if (!databaseUrl) {
    const pgPort = await findFreePort();
    pgDataDir = await mkdtemp(join(tmpdir(), 'food-e2e-pg-'));
    embeddedPg = new EmbeddedPostgres({
      databaseDir: pgDataDir,
      user: 'food_e2e',
      password: 'e2e_pg_password_not_secret',
      port: pgPort,
      persistent: false,
      authMethod: 'password',
      initdbFlags: ['--encoding=UTF8', '--locale=C.UTF-8'],
      postgresFlags: ['-c', 'log_min_messages=warning'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embeddedPg.initialise();
    await embeddedPg.start();
    await embeddedPg.createDatabase('food_e2e');
    databaseUrl = `postgres://food_e2e:e2e_pg_password_not_secret@127.0.0.1:${pgPort}/food_e2e`;
  }

  const uploadDir = await mkdtemp(join(tmpdir(), 'food-e2e-uploads-'));
  await runMigrations({ connectionString: databaseUrl, log: () => undefined });

  const pool = createPool(databaseUrl, 12, 'food-e2e-api');
  pool.on('error', () => undefined);
  const db = createDb(pool);

  if (process.env.TEST_DATABASE_URL) {
    const rows = (
      (await db.execute(
        rawSql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'`),
      )) as unknown as { rows: { tablename: string }[] }
    ).rows;
    const names = rows.map((r) => `"${r.tablename}"`).join(', ');
    if (names) await db.execute(rawSql(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`));
  }

  resetBaseCache();
  const base = await seedBase(db);
  const now = new Date();

  const food1 = await createFood(db, 'چلوکباب کوبیده زعفرانی', { defaultPriceRial: 150_000, category: 'کبابی' });
  const food2 = await createFood(db, 'چلوخورش قورمه‌سبزی', { defaultPriceRial: 120_000, category: 'خورشتی' });

  // تنظیم پنجرهٔ زمانی وعدهٔ Lunch در روز جاری تهران تا هم رزرو و هم تحویل در هر ساعتی از شبانه‌روز مجاز باشد
  const firstDeliverable = await createDeliverableOffering(db, {
    capacity: 50,
    price: 150_000,
  });
  await db.execute(rawSql(`UPDATE meal_offerings SET food_id = $1 WHERE id = $2`, [food1, firstDeliverable.id]));

  await createOffering(db, {
    serviceDate: firstDeliverable.serviceDate,
    mealSlot: 'Lunch',
    foodId: food2,
    cafeteriaId: base.cafeteriaId,
    capacity: 50,
    status: 'Published',
    prices: { Student: 120_000 },
    reserveOpensAt: new Date(now.getTime() - 6 * 3600_000),
    reserveDeadline: new Date(now.getTime() + 30 * 60_000),
  });

  await createStudent(db, {
    studentNumber: '402123456',
    fullName: 'سارا محمدی',
    nationalId: makeNationalId(1),
    balanceRial: 300_000,
    pepper,
  });

  await createStaff(db, {
    username: 'superadmin1',
    password: 'SuperAdmin#2026!',
    role: 'SuperAdmin',
  });
  await createStaff(db, {
    username: 'affairs1',
    password: 'Affairs#2026!',
    role: 'StudentAffairs',
  });
  await createStaff(db, {
    username: 'operator1',
    password: 'Operator#2026!',
    role: 'Operator',
    cafeteriaId: base.cafeteriaId,
  });
  await createStaff(db, {
    username: 'nutrition1',
    password: 'Nutrition#2026!',
    role: 'NutritionManager',
  });

  const webDist = resolve(import.meta.dirname, '../dist');
  const envParsed = readEnv(
    testEnv({
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: databaseUrl,
      NATIONAL_ID_PEPPER: pepper,
      UPLOAD_DIR: uploadDir,
      SERVE_STATIC: 'true',
      WEB_DIST_PATH: webDist,
      ONLINE_PAYMENT_ENABLED: 'true',
      ALLOW_SANDBOX_GATEWAY: 'true',
      RATE_LIMIT_AUTH_MAX: '500',
      RATE_LIMIT_WRITE_MAX: '2000',
      RATE_LIMIT_READ_MAX: '5000',
    }) as NodeJS.ProcessEnv,
  );
  if (!envParsed.ok) throw new Error(envParsed.issues.join(' | '));

  const app = await buildApp({ env: envParsed.env, db, logger: createSilentLogger() });
  await app.listen({ host: '127.0.0.1', port: apiPort });
  console.info(`[e2e] سرور آزمون سرتاسری روی ${baseUrl} آماده شد.`);

  const shutdown = async () => {
    await app.close();
    await pool.end();
    if (embeddedPg) await embeddedPg.stop();
    if (pgDataDir) await rm(pgDataDir, { recursive: true, force: true });
    await rm(uploadDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
