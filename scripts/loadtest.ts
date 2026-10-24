import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
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
 * آزمون جامع بار، هم‌زمانی و کارایی سامانه اتوماسیون تغذیه دانشگاه شمال (`npm run loadtest`)
 * اجرا روی PostgreSQL واقعی با ثبت شاخص‌های دقیق برای `docs/PERF.md`:
 *  ۱. واردسازی اکسل ۵٬۰۰۰ سطر (هدف: پیش‌نمایش < ۱۰s، کامیت < ۲۰s) و ۲۰٬۰۰۰ سطر
 *  ۲. ۳۰۰ درخواست رزرو هم‌زمان برای ظرفیت ۲۰۰ (هدف: دقیقاً ۲۰۰ موفق، ۰ موجودی منفی، تراز دفتر کل صفر، p95 < 1.5s)
 *  ۳. ۱٬۰۰۰ ورود هم‌زمان دانشجو + ورود هم‌زمان کارکنان (Argon2id)
 *  ۴. ۲٬۰۰۰ خواندن هم‌زمان منو (`GET /api/v1/me/menu`)
 *  ۵. ۲۰ callback هم‌زمان درگاه پرداخت برای یک پرداخت واحد ⇒ دقیقاً ۱ شارژ (`Deposit`) و ۱ رزرو
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

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

async function runAutocannon(opts: AutocannonOptions): Promise<AutocannonResult> {
  return new Promise((resolve, reject) => {
    autocannon(opts, (err: Error | null, result: AutocannonResult) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function buildStudentExcelBuffer(rowCount: number, seedOffset: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('دانشجویان');
  ws.addRow(['شماره دانشجویی', 'نام و نام خانوادگی', 'کد ملی', 'دانشکده', 'رشته', 'مقطع', 'سال ورود']);
  const faculties = ['فنی و مهندسی', 'علوم پایه', 'مدیریت و اقتصاد', 'معماری و هنر'];
  const majors = ['مهندسی کامپیوتر', 'مهندسی عمران', 'مدیریت صنعتی', 'معماری'];
  const degrees = ['کارشناسی', 'کارشناسی ارشد', 'دکتری'];

  for (let i = 1; i <= rowCount; i += 1) {
    const sn = String(401_000_000 + seedOffset + i);
    const nid = makeNationalId(seedOffset + i);
    ws.addRow([
      sn,
      `دانشجوی آزمایشی ${i}`,
      nid,
      faculties[i % faculties.length],
      majors[i % majors.length],
      degrees[i % degrees.length],
      1401 + (i % 4),
    ]);
  }
  const arrayBuf = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

async function main(): Promise<void> {
  const cpuInfo = cpus();
  console.info('=== مشخصات ماشین آزمون ===');
  console.info(
    JSON.stringify({
      os: `${platform()} ${release()}`,
      node: process.version,
      vcpuCount: cpuInfo.length,
      cpuModel: cpuInfo[0]?.model ?? 'unknown',
      totalRamGiB: Number((totalmem() / 1024 ** 3).toFixed(2)),
      freeRamGiB: Number((freemem() / 1024 ** 3).toFixed(2)),
    }),
  );

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
      postgresFlags: ['-c', 'log_min_messages=warning', '-c', 'max_connections=120', '-c', 'shared_buffers=256MB'],
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

  const pool = createPool(databaseUrl, 20, 'food-loadtest-api');
  pool.on('error', () => undefined);
  const db = createDb(pool);

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
  await db.execute(
    rawSql(
      `INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now()`,
    ),
  );

  const envParsed = readEnv(
    testEnv({
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: '20',
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
    console.info('=== شروع آزمون جامع بار و هم‌زمانی سامانه اتوماسیون تغذیه ===');

    const pgVerRes = (await db.execute(rawSql(`SHOW server_version`))) as unknown as { rows: { server_version: string }[] };
    console.info(`PostgreSQL server_version: ${pgVerRes.rows[0]?.server_version ?? 'unknown'}`);

    const staffPassword = 'LoadTestStaff#2026!';
    await createStaff(db, {
      username: 'loadtest_sa',
      password: staffPassword,
      role: 'StudentAffairs',
    });
    await createStaff(db, {
      username: 'loadtest_nm',
      password: staffPassword,
      role: 'NutritionManager',
    });

    const loginStaffHttp = async (username: string) => {
      const initRes = await fetch(`${baseUrl}/api/v1/auth/setup-status`);
      const jar = parseSetCookies(initRes.headers);
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/staff/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseUrl,
          cookie: serializeCookies(jar),
          'x-csrf-token': jar.csrf ?? '',
        },
        body: JSON.stringify({ username, password: staffPassword }),
      });
      if (loginRes.status !== 200) throw new Error(`ورود کارکنان ناموفق: ${loginRes.status}`);
      Object.assign(jar, parseSetCookies(loginRes.headers));
      return { cookieHeader: serializeCookies(jar), csrf: jar.csrf ?? '' };
    };

    const saSession = await loginStaffHttp('loadtest_sa');

    // -------------------------------------------------------------------------
    // سناریو ۱: واردسازی اکسل ۵٬۰۰۰ سطر و ۲۰٬۰۰۰ سطر
    // -------------------------------------------------------------------------
    const runExcelBench = async (rowCount: number, seedOffset: number) => {
      const xlsxBuf = await buildStudentExcelBuffer(rowCount, seedOffset);
      const form = new FormData();
      form.append(
        'file',
        new Blob([xlsxBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `students-${rowCount}.xlsx`,
      );

      const previewT0 = performance.now();
      const previewRes = await fetch(`${baseUrl}/api/v1/imports/preview?policy=RejectAllOnError&fullSync=false`, {
        method: 'POST',
        headers: {
          origin: baseUrl,
          cookie: saSession.cookieHeader,
          'x-csrf-token': saSession.csrf,
        },
        body: form,
      });
      const previewBody = (await previewRes.json()) as { batchId?: string; summary?: { total: number; valid: number } };
      const previewMs = Math.round(performance.now() - previewT0);
      if (previewRes.status !== 200 || !previewBody.batchId) {
        throw new Error(`پیش‌نمایش اکسل ${rowCount} ردیفی شکست خورد: status=${previewRes.status} body=${JSON.stringify(previewBody)}`);
      }

      const commitT0 = performance.now();
      const commitRes = await fetch(`${baseUrl}/api/v1/imports/${previewBody.batchId}/commit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseUrl,
          cookie: saSession.cookieHeader,
          'x-csrf-token': saSession.csrf,
        },
        body: JSON.stringify({}),
      });
      const commitBody = (await commitRes.json()) as { created?: number; updated?: number; written?: number };
      const commitMs = Math.round(performance.now() - commitT0);
      if (commitRes.status !== 200 || commitBody.written !== rowCount) {
        throw new Error(`کامیت اکسل ${rowCount} ردیفی شکست خورد: status=${commitRes.status} body=${JSON.stringify(commitBody)}`);
      }
      return { sizeKB: Math.round(xlsxBuf.length / 1024), previewMs, commitMs };
    };

    const imp5k = await runExcelBench(5_000, 100_000);
    console.info(
      `[۱-الف/۵] واردسازی اکسل ۵٬۰۰۰ سطر (${imp5k.sizeKB} KB): پیش‌نمایش=${imp5k.previewMs}ms (هدف <10000ms)، کامیت=${imp5k.commitMs}ms (هدف <20000ms)`,
    );
    if (imp5k.previewMs >= 10_000 || imp5k.commitMs >= 20_000) {
      throw new Error(`واردسازی ۵٬۰۰۰ سطر از هدف زمانی عبور کرد: preview=${imp5k.previewMs}ms, commit=${imp5k.commitMs}ms`);
    }

    const imp20k = await runExcelBench(20_000, 300_000);
    console.info(`[۱-ب/۵] واردسازی اکسل ۲۰٬۰۰۰ سطر (${imp20k.sizeKB} KB): پیش‌نمایش=${imp20k.previewMs}ms، کامیت=${imp20k.commitMs}ms`);

    // -------------------------------------------------------------------------
    // آماده‌سازی ۳۰۱ دانشجوی دارای اعتبار برای رزرو هم‌زمان، خواندن منو و درگاه
    // -------------------------------------------------------------------------
    const serviceDate = addDays(tehranToday(), 2);
    const offering = await createOffering(db, {
      serviceDate,
      mealSlot: 'Lunch',
      capacity: 200,
      status: 'Published',
      prices: { Student: 150_000 },
    });
    const gatewayOffering = await createOffering(db, {
      serviceDate: addDays(tehranToday(), 3),
      mealSlot: 'Dinner',
      capacity: 50,
      status: 'Published',
      prices: { Student: 180_000 },
    });

    const studentCreds: { studentNumber: string; nationalId: string }[] = [];
    for (let i = 1; i <= 301; i += 1) {
      const st = await createStudent(db, {
        studentNumber: `40499${String(i).padStart(4, '0')}`,
        nationalId: makeNationalId(900_000 + i),
        balanceRial: i <= 300 ? 200_000 : 0, // نفر ۳۰۱ موجودی صفر دارد تا به درگاه هدایت شود
        pepper,
      });
      studentCreds.push({ studentNumber: st.studentNumber, nationalId: st.nationalId });
    }

    const loginOneStudent = async (cred: { studentNumber: string; nationalId: string }) => {
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
      return { cookieHeader: serializeCookies(jar), csrf: jar.csrf ?? '' };
    };

    const sessions: { cookieHeader: string; csrf: string }[] = [];
    for (let offset = 0; offset < studentCreds.length; offset += 50) {
      const batch = await Promise.all(studentCreds.slice(offset, offset + 50).map(loginOneStudent));
      sessions.push(...batch);
    }
    const raceSessions = sessions.slice(0, 300);
    const gatewaySession = sessions[300]!;

    // -------------------------------------------------------------------------
    // سناریو ۲: ۳۰۰ درخواست رزرو هم‌زمان برای ظرفیت ۲۰۰ (از Worker مستقل تا حلقهٔ رویداد سرور با کلاینت تداخل نکند)
    // -------------------------------------------------------------------------
    const raceWorkerScript = `
      const http = require('node:http');
      const { parentPort, workerData } = require('node:worker_threads');
      const { performance } = require('node:perf_hooks');

      const agent = new http.Agent({ keepAlive: true, maxSockets: 300 });
      const { port, baseUrl, offeringId, sessions } = workerData;

      async function run() {
        const wallT0 = performance.now();
        const results = await Promise.all(
          sessions.map((sess, idx) => new Promise((resolve, reject) => {
            const payload = JSON.stringify({
              items: [{ offeringId }],
              idempotencyKey: 'race300-checkout-' + String(idx + 1).padStart(4, '0'),
            });
            const reqT0 = performance.now();
            const req = http.request({
              hostname: '127.0.0.1',
              port,
              path: '/api/v1/payments/checkout/start',
              method: 'POST',
              agent,
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                origin: baseUrl,
                cookie: sess.cookieHeader,
                'x-csrf-token': sess.csrf,
              },
            }, (res) => {
              let raw = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => { raw += chunk; });
              res.on('end', () => {
                const latencyMs = performance.now() - reqT0;
                let body = {};
                try { body = JSON.parse(raw); } catch {}
                resolve({ status: res.statusCode || 0, body, latencyMs });
              });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
          }))
        );
        const wallMs = Math.round(performance.now() - wallT0);
        agent.destroy();
        parentPort.postMessage({ wallMs, results });
      }
      run().catch((err) => { throw err; });
    `;

    const { wallMs: raceTotalMs, results: raceResponses } = await new Promise<{
      wallMs: number;
      results: { status: number; body: Record<string, unknown>; latencyMs: number }[];
    }>((resolve, reject) => {
      const worker = new Worker(raceWorkerScript, {
        eval: true,
        workerData: { port: apiPort, baseUrl, offeringId: offering.id, sessions: raceSessions },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const sortedLatencies = raceResponses.map((r) => r.latencyMs).sort((a, b) => a - b);
    const raceP50 = Math.round(percentile(sortedLatencies, 50));
    const raceP95 = Math.round(percentile(sortedLatencies, 95));
    const raceP99 = Math.round(percentile(sortedLatencies, 99));
    const raceMax = Math.round(sortedLatencies[sortedLatencies.length - 1] ?? 0);

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
    const verifyNegBalances = (
      (await db.execute(rawSql(`SELECT COUNT(*)::int AS c FROM accounts WHERE balance_rial < 0`))) as unknown as {
        rows: { c: number }[];
      }
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
      `[۲/۵] رقابت ۳۰۰ رزرو هم‌زمان روی ظرفیت ۲۰۰ (کل=${raceTotalMs}ms، p50=${raceP50}ms، p95=${raceP95}ms، p99=${raceP99}ms، max=${raceMax}ms): موفق=${okCount}، رد ظرفیت=${conflictCount}، reserved_count=${verifyOff.c}، رزرو فعال=${verifyRes.c}، موجودی منفی=${verifyNegBalances.c}، جمع صفر دفتر کل=${verifyDoubleEntry.net_sum}، عدم تطابق حساب=${verifyAccountBalances.mismatch_count}`,
    );
    if (
      okCount !== 200 ||
      conflictCount !== 100 ||
      Number(verifyOff.c) !== 200 ||
      Number(verifyRes.c) !== 200 ||
      Number(verifyNegBalances.c) !== 0 ||
      verifyDoubleEntry.net_sum !== '0' ||
      Number(verifyAccountBalances.mismatch_count) !== 0 ||
      raceP95 >= 1500
    ) {
      throw new Error(`خطا در معیارهای سناریوی ۳۰۰ رزرو هم‌زمان! ok=${okCount}, p95=${raceP95}ms`);
    }

    // -------------------------------------------------------------------------
    // سناریو ۳: ۱٬۰۰۰ ورود هم‌زمان دانشجو + ورود هم‌زمان کارکنان (Argon2id)
    // -------------------------------------------------------------------------
    const csrfInit = await fetch(`${baseUrl}/api/v1/auth/setup-status`);
    const csrfJar = parseSetCookies(csrfInit.headers);
    const sharedCsrfHeaders = {
      'content-type': 'application/json',
      origin: baseUrl,
      cookie: serializeCookies(csrfJar),
      'x-csrf-token': csrfJar.csrf ?? '',
    };

    const studentLoginBench = await runAutocannon({
      url: baseUrl,
      connections: 50,
      amount: 1000,
      requests: studentCreds.slice(0, 100).map((cred) => ({
        method: 'POST',
        path: '/api/v1/auth/student/login',
        headers: sharedCsrfHeaders,
        body: JSON.stringify(cred),
      })),
    });
    console.info(
      `[۳-الف/۵] ۱٬۰۰۰ ورود هم‌زمان دانشجو (۵۰ اتصال): 2xx=${studentLoginBench['2xx']}, خطا=${studentLoginBench.errors}, میانگین=${studentLoginBench.latency.average}ms, p50=${studentLoginBench.latency.p50}ms, p97.5=${studentLoginBench.latency.p97_5}ms, p99=${studentLoginBench.latency.p99}ms, توان=${Math.round(studentLoginBench.requests.average)} req/s`,
    );
    if (studentLoginBench.errors > 0 || studentLoginBench.non2xx > 0) {
      throw new Error(`خطا در آزمون ۱٬۰۰۰ ورود دانشجو: non2xx=${studentLoginBench.non2xx}, errors=${studentLoginBench.errors}`);
    }

    const staffLoginBench = await runAutocannon({
      url: `${baseUrl}/api/v1/auth/staff/login`,
      method: 'POST',
      connections: 10,
      amount: 100,
      headers: sharedCsrfHeaders,
      body: JSON.stringify({ username: 'loadtest_nm', password: staffPassword }),
    });
    console.info(
      `[۳-ب/۵] ۱۰۰ ورود هم‌زمان کارکنان Argon2id (۱۰ اتصال، ۱۹MiB OWASP): 2xx=${staffLoginBench['2xx']}, خطا=${staffLoginBench.errors}, میانگین=${staffLoginBench.latency.average}ms, p97.5=${staffLoginBench.latency.p97_5}ms, توان=${Math.round(staffLoginBench.requests.average)} req/s`,
    );
    if (staffLoginBench.errors > 0 || staffLoginBench.non2xx > 0) {
      throw new Error(`خطا در آزمون ورود Argon2id: non2xx=${staffLoginBench.non2xx}, errors=${staffLoginBench.errors}`);
    }

    // -------------------------------------------------------------------------
    // سناریو ۴: ۲٬۰۰۰ خواندن هم‌زمان منو
    // -------------------------------------------------------------------------
    const menuBench = await runAutocannon({
      url: `${baseUrl}/api/v1/me/menu?from=${serviceDate}&to=${addDays(serviceDate, 5)}`,
      method: 'GET',
      connections: 50,
      amount: 2000,
      headers: {
        cookie: raceSessions[0]!.cookieHeader,
      },
    });
    console.info(
      `[۴/۵] ۲٬۰۰۰ خواندن هم‌زمان منو (۵۰ اتصال): 2xx=${menuBench['2xx']}, خطا=${menuBench.errors}, میانگین=${menuBench.latency.average}ms, p50=${menuBench.latency.p50}ms, p97.5=${menuBench.latency.p97_5}ms, p99=${menuBench.latency.p99}ms, توان=${Math.round(menuBench.requests.average)} req/s`,
    );
    if (menuBench.errors > 0 || menuBench.non2xx > 0) {
      throw new Error(`خطا در آزمون ۲٬۰۰۰ خواندن منو: non2xx=${menuBench.non2xx}, errors=${menuBench.errors}`);
    }

    // -------------------------------------------------------------------------
    // سناریو ۵: ۲۰ callback هم‌زمان درگاه پرداخت برای یک پرداخت واحد ⇒ دقیقاً ۱ شارژ
    // -------------------------------------------------------------------------
    const startGwRes = await fetch(`${baseUrl}/api/v1/payments/checkout/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        cookie: gatewaySession.cookieHeader,
        'x-csrf-token': gatewaySession.csrf,
      },
      body: JSON.stringify({
        items: [{ offeringId: gatewayOffering.id }],
        idempotencyKey: 'gw-callback-race-20',
      }),
    });
    const startGwBody = (await startGwRes.json()) as { mode?: string; paymentId?: string; redirectUrl?: string };
    if (startGwRes.status !== 200 || startGwBody.mode !== 'gateway' || !startGwBody.paymentId || !startGwBody.redirectUrl) {
      throw new Error(`شروع پرداخت درگاه برای آزمون callback ناموفق بود: ${startGwRes.status} ${JSON.stringify(startGwBody)}`);
    }
    const redirectParsed = new URL(startGwBody.redirectUrl, baseUrl);
    const authority =
      redirectParsed.searchParams.get('Authority') ??
      redirectParsed.searchParams.get('authority') ??
      redirectParsed.pathname.split('/').pop() ??
      '';
    if (!authority) throw new Error(`Authority در URL درگاه یافت نشد: ${startGwBody.redirectUrl}`);

    const cbWallT0 = performance.now();
    const cbResponses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(
          `${baseUrl}/api/v1/payments/zarinpal/callback?paymentId=${encodeURIComponent(startGwBody.paymentId!)}&Authority=${encodeURIComponent(authority)}&Status=OK`,
          {
            method: 'GET',
            redirect: 'manual',
          },
        ),
      ),
    );
    const cbWallMs = Math.round(performance.now() - cbWallT0);
    const redirectCount = cbResponses.filter((r) => r.status >= 300 && r.status < 400).length;

    const depositRows = (
      (await db.execute(
        rawSql(
          `SELECT COUNT(*)::int AS c FROM ledger_transactions WHERE reference_type = 'Payment' AND reference_id = $1::uuid AND type = 'OnlinePayment'`,
          [startGwBody.paymentId],
        ),
      )) as unknown as { rows: { c: number }[] }
    ).rows[0]!;
    const gwResRows = (
      (await db.execute(
        rawSql(`SELECT COUNT(*)::int AS c FROM reservations WHERE offering_id = $1::uuid AND status = 'Reserved'`, [gatewayOffering.id]),
      )) as unknown as { rows: { c: number }[] }
    ).rows[0]!;
    const finalLedgerSum = (
      (await db.execute(rawSql(`SELECT COALESCE(SUM(amount_rial), 0)::bigint AS net_sum FROM ledger_entries`))) as unknown as {
        rows: { net_sum: string }[];
      }
    ).rows[0]!;

    console.info(
      `[۵/۵] ۲۰ callback هم‌زمان درگاه پرداخت (${cbWallMs}ms): پاسخ ریدایرکت=${redirectCount}/20، تعداد تراکنش شارژ OnlinePayment=${depositRows.c}، تعداد رزرو ثبت‌شده=${gwResRows.c}، تراز کل دفتر کل=${finalLedgerSum.net_sum}`,
    );
    if (redirectCount !== 20 || Number(depositRows.c) !== 1 || Number(gwResRows.c) !== 1 || finalLedgerSum.net_sum !== '0') {
      throw new Error(`خطا در idempotency بیست callback هم‌زمان درگاه: deposits=${depositRows.c}, res=${gwResRows.c}`);
    }

    // اجرای EXPLAIN (ANALYZE, BUFFERS) روی پرس‌وجوهای داغ سامانه
    const explainStudent = (
      (await db.execute(
        rawSql(`EXPLAIN (ANALYZE, BUFFERS) SELECT id, status FROM students WHERE student_number = '401315000'`),
      )) as unknown as { rows: { 'QUERY PLAN': string }[] }
    ).rows.map((r) => r['QUERY PLAN']);
    console.info(`[EXPLAIN-1] جست‌وجوی دانشجو در جدول ۲۵٬۰۰۰+ ردیفی:\n  ${explainStudent.join('\n  ')}`);

    const explainMenu = (
      (await db.execute(
        rawSql(
          `EXPLAIN (ANALYZE, BUFFERS)
           SELECT o.id, o.service_date, o.capacity, o.reserved_count
           FROM meal_offerings o
           WHERE o.deleted_at IS NULL AND o.status = 'Published' AND o.service_date >= $1::date AND o.service_date <= $2::date`,
          [serviceDate, addDays(serviceDate, 5)],
        ),
      )) as unknown as { rows: { 'QUERY PLAN': string }[] }
    ).rows.map((r) => r['QUERY PLAN']);
    console.info(`[EXPLAIN-2] خواندن وعده‌های منوی بازهٔ هفتگی:\n  ${explainMenu.join('\n  ')}`);

    console.info('=== همهٔ آزمون‌های بار، کارایی و هم‌زمانی با موفقیت ۱۰۰٪ به پایان رسیدند ===');
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
