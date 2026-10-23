import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import autocannon, { type Options as AutocannonOptions, type Result as AutocannonResult } from 'autocannon';
import EmbeddedPostgres from 'embedded-postgres';
import { addDays, tehranToday } from '@food/shared';
import { buildApp } from '../apps/api/src/app.js';
import { readEnv, testEnv } from '../apps/api/src/config/env.js';
import { createDb, createPool } from '../apps/api/src/db/client.js';
import { runMigrations } from '../apps/api/src/db/migrate.js';
import { rawSql } from '../apps/api/src/db/raw.js';
import { createSilentLogger } from '../apps/api/src/lib/logger.js';
import { createOffering, createStaff, createStudent, makeNationalId, resetBaseCache, seedBase } from '../apps/api/test/helpers/fixtures.js';

/**
 * آزمون بار و هم‌زمانی سامانه اتوماسیون تغذیه دانشگاه شمال (`npm run loadtest`):
 *  ۱. ۵۰۰ درخواست خواندن منو (`GET /api/v1/me/menu`) با autocannon
 *  ۲. ۵۰ درخواست هم‌زمان برای آخرین ۱۰ ظرفیت یک وعده (`capacity = 10`) و اثبات عدم رزرو بیش از ظرفیت و سلامت دفتر کل
 *  ۳. ۳۲ ورود هم‌زمان کارکنان با Argon2id (`POST /api/v1/auth/staff/login`) با autocannon
 */

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function parseSetCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0] ?? '';
    const idx = pair.indexOf('=');
    if (idx > 0) {
      cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return cookies;
}

function serializeCookies(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function runAutocannon(opts: AutocannonOptions): Promise<AutocannonResult> {
  return new Promise((resolve, reject) => {
    autocannon(opts, (err: Error | null, result: AutocannonResult) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function main(): Promise<void> {
  const externalDbUrl = process.env.LOADTEST_DATABASE_URL?.trim() || process.env.TEST_DATABASE_URL?.trim();
  let embeddedPg: EmbeddedPostgres | null = null;
  let pgDataDir = '';
  let databaseUrl = externalDbUrl ?? '';

  if (!databaseUrl) {
    const pgPort = await findFreePort();
    pgDataDir = await mkdtemp(join(tmpdir(), 'food-loadtest-pg-'));
    embeddedPg = new EmbeddedPostgres({
      databaseDir: pgDataDir,
      user: 'food_loadtest',
      password: 'loadtest_pg_password_not_secret',
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
    await embeddedPg.createDatabase('food_loadtest');
    databaseUrl = `postgres://food_loadtest:loadtest_pg_password_not_secret@127.0.0.1:${pgPort}/food_loadtest`;
  }

  const uploadDir = await mkdtemp(join(tmpdir(), 'food-loadtest-uploads-'));
  const apiPort = await findFreePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const pepper = 'loadtest-national-id-pepper-0123456789abcdef';

  await runMigrations({ connectionString: databaseUrl, log: () => undefined });

  const pool = createPool(databaseUrl, 24, 'food-loadtest-api');
  pool.on('error', () => undefined);
  const db = createDb(pool);

  // در صورت استفاده از دیتابیس مشترک CI، پیش از اجرای آزمون پاک‌سازی می‌کنیم
  if (externalDbUrl) {
    const rows = (
      (await db.execute(
        rawSql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_drizzle%'`),
      )) as unknown as { rows: { tablename: string }[] }
    ).rows;
    const names = rows.map((r) => `"${r.tablename}"`).join(', ');
    if (names) await db.execute(rawSql(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`));
  }

  resetBaseCache();
  await seedBase(db);

  const envParsed = readEnv(
    testEnv({
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: '24',
      NATIONAL_ID_PEPPER: pepper,
      UPLOAD_DIR: uploadDir,
      ONLINE_PAYMENT_ENABLED: 'true',
      ALLOW_SANDBOX_GATEWAY: 'true',
      RATE_LIMIT_DEFAULT_MAX: '100000',
      RATE_LIMIT_LOGIN_ROUTE_MAX: '100000',
      RATE_LIMIT_LOGIN_MAX: '100000',
      RATE_LIMIT_WRITE_MAX: '100000',
    }) as NodeJS.ProcessEnv,
  );
  if (!envParsed.ok) throw new Error(envParsed.issues.join(' | '));

  const app = await buildApp({ env: envParsed.env, db, logger: createSilentLogger() });
  await app.listen({ host: '127.0.0.1', port: apiPort });

  try {
    console.info('=== شروع آزمون بار و هم‌زمانی سامانه اتوماسیون تغذیه ===');

    const serviceDate = addDays(tehranToday(), 2);
    const offering = await createOffering(db, {
      serviceDate,
      mealSlot: 'Lunch',
      capacity: 10,
      status: 'Published',
      prices: { Student: 150_000 },
    });

    const staffPassword = 'LoadTestStaff#2026!';
    await createStaff(db, {
      username: 'loadtest_admin',
      password: staffPassword,
      role: 'NutritionManager',
    });

    const studentCreds: { studentNumber: string; nationalId: string }[] = [];
    for (let i = 1; i <= 50; i += 1) {
      const st = await createStudent(db, {
        studentNumber: `40388${String(i).padStart(4, '0')}`,
        nationalId: makeNationalId(50_000 + i),
        balanceRial: 200_000,
        pepper,
      });
      studentCreds.push({ studentNumber: st.studentNumber, nationalId: st.nationalId });
    }

    const sessions: { cookieHeader: string; csrf: string }[] = [];
    for (const cred of studentCreds) {
      const initRes = await fetch(`${baseUrl}/api/v1/auth/setup-status`);
      const jar = parseSetCookies(initRes.headers);
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/student/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseUrl,
          cookie: serializeCookies(jar),
          'x-csrf-token': jar.csrf ?? '',
        },
        body: JSON.stringify(cred),
      });
      if (loginRes.status !== 200) {
        throw new Error(`ورود دانشجوی آزمون ناموفق بود: ${loginRes.status}`);
      }
      Object.assign(jar, parseSetCookies(loginRes.headers));
      sessions.push({ cookieHeader: serializeCookies(jar), csrf: jar.csrf ?? '' });
    }

    // --- سناریو ۱: ۵۰۰ درخواست هم‌زمان خواندن منو ---
    const menuBench = await runAutocannon({
      url: `${baseUrl}/api/v1/me/menu?from=${serviceDate}&to=${serviceDate}`,
      method: 'GET',
      connections: 25,
      amount: 500,
      headers: {
        cookie: sessions[0]!.cookieHeader,
      },
    });
    console.info(
      `[۱/۳] منوی دانشجو (۵۰۰ درخواست، ۲۵ اتصال هم‌زمان): 2xx=${menuBench['2xx']}, خطا=${menuBench.errors}, میانگین=${menuBench.latency.average}ms, p97.5=${menuBench.latency.p97_5}ms, توان=${Math.round(menuBench.requests.average)} req/s`,
    );
    if (menuBench.errors > 0 || menuBench.non2xx > 0) {
      throw new Error(`خطا در آزمون خواندن منو: non2xx=${menuBench.non2xx}, errors=${menuBench.errors}`);
    }

    // --- سناریو ۲: رقابت ۵۰ دانشجو روی آخرین ۱۰ ظرفیت ---
    const raceStart = performance.now();
    const raceResponses = await Promise.all(
      sessions.map((sess, idx) =>
        fetch(`${baseUrl}/api/v1/payments/checkout/start`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: baseUrl,
            cookie: sess.cookieHeader,
            'x-csrf-token': sess.csrf,
          },
          body: JSON.stringify({
            items: [{ offeringId: offering.id }],
            idempotencyKey: `race-checkout-key-${String(idx + 1).padStart(4, '0')}`,
          }),
        }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> })),
      ),
    );
    const raceDurationMs = Math.round(performance.now() - raceStart);
    const okCount = raceResponses.filter((r) => r.status === 200 && r.body.mode === 'instant').length;
    const conflictCount = raceResponses.filter((r) => r.status === 409).length;

    const verifyOff = (
      (await db.execute(rawSql(`SELECT reserved_count AS c FROM meal_offerings WHERE id = $1`, [offering.id]))) as unknown as {
        rows: { c: number }[];
      }
    ).rows[0]!;
    const verifyRes = (
      (await db.execute(
        rawSql(`SELECT COUNT(*)::int AS c FROM reservations WHERE offering_id = $1 AND status = 'Reserved'`, [offering.id]),
      )) as unknown as { rows: { c: number }[] }
    ).rows[0]!;
    const verifyDoubleEntry = (
      (await db.execute(rawSql(`SELECT COALESCE(SUM(amount_rial), 0)::bigint AS net_sum FROM ledger_entries`))) as unknown as {
        rows: { net_sum: string }[];
      }
    ).rows[0]!;
    const verifyAccountBalances = (
      (await db.execute(
        rawSql(
          `SELECT COUNT(*)::int AS mismatch_count
           FROM accounts a
           LEFT JOIN (
             SELECT account_id, COALESCE(SUM(amount_rial), 0)::bigint AS entry_sum
             FROM ledger_entries
             WHERE account_id IS NOT NULL
             GROUP BY account_id
           ) le ON le.account_id = a.id
           WHERE a.balance_rial <> COALESCE(le.entry_sum, 0)`,
        ),
      )) as unknown as { rows: { mismatch_count: number }[] }
    ).rows[0]!;

    console.info(
      `[۲/۳] رقابت ۵۰ درخواست روی آخرین ۱۰ ظرفیت (${raceDurationMs}ms): موفق=${okCount}، رد ظرفیت=${conflictCount}، reserved_count=${verifyOff.c}، رزرو ثبت‌شده=${verifyRes.c}، جمع صفر دفتر کل=${verifyDoubleEntry.net_sum}، عدم تطابق حساب‌ها=${verifyAccountBalances.mismatch_count}`,
    );
    if (
      okCount !== 10 ||
      conflictCount !== 40 ||
      Number(verifyOff.c) !== 10 ||
      Number(verifyRes.c) !== 10 ||
      verifyDoubleEntry.net_sum !== '0' ||
      Number(verifyAccountBalances.mismatch_count) !== 0
    ) {
      throw new Error('ناهمخوانی در رقابت ظرفیت یا دفتر کل شناسایی شد!');
    }

    // --- سناریو ۳: ورود هم‌زمان Argon2id ---
    const csrfInit = await fetch(`${baseUrl}/api/v1/auth/setup-status`);
    const staffJar = parseSetCookies(csrfInit.headers);
    const loginBench = await runAutocannon({
      url: `${baseUrl}/api/v1/auth/staff/login`,
      method: 'POST',
      connections: 8,
      amount: 32,
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        cookie: serializeCookies(staffJar),
        'x-csrf-token': staffJar.csrf ?? '',
      },
      body: JSON.stringify({ username: 'loadtest_admin', password: staffPassword }),
    });
    console.info(
      `[۳/۳] ورود Argon2id کارکنان (۳۲ ورود، ۸ اتصال هم‌زمان): 2xx=${loginBench['2xx']}, خطا=${loginBench.errors}, میانگین=${loginBench.latency.average}ms, p97.5=${loginBench.latency.p97_5}ms`,
    );
    if (loginBench.errors > 0 || loginBench.non2xx > 0) {
      throw new Error(`خطا در آزمون ورود Argon2id: non2xx=${loginBench.non2xx}, errors=${loginBench.errors}`);
    }

    console.info('=== همهٔ آزمون‌های بار و هم‌زمانی با موفقیت کامل به پایان رسیدند ===');
  } finally {
    await app.close();
    await pool.end();
    if (embeddedPg) {
      await embeddedPg.stop();
    }
    if (pgDataDir) {
      await rm(pgDataDir, { recursive: true, force: true });
    }
    await rm(uploadDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error('شکست در اجرای آزمون بار:', error);
  process.exit(1);
});
