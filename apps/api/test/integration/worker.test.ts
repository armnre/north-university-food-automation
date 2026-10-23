import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { tehranToday } from '@food/shared';
import { createDb, createPool } from '../../src/db/client.js';
import { mealOfferings, reservations } from '../../src/db/schema/index.js';
import { readEnv, testEnv } from '../../src/config/env.js';
import { createSilentLogger } from '../../src/lib/logger.js';
import { randomHex } from '../../src/lib/crypto.js';
import { reconcileLedger } from '../../src/services/ledger.service.js';
import { invalidateSettingsCacheForDb } from '../../src/services/settings.service.js';
import { runAllWorkerJobsOnce, runLockedJob } from '../../src/services/worker-jobs.js';
import { getTestDb, openClient, query, resetDatabase, testAppRoleDatabaseUrl } from '../helpers/db.js';
import { createOffering, createStudent, resetBaseCache, seedBase } from '../helpers/fixtures.js';

const db = getTestDb();

describe('سرویس زمان‌بند پس‌زمینه (food-worker)', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetBaseCache();
    await seedBase(db);
  });

  beforeEach(async () => {
    await resetDatabase();
    resetBaseCache();
    await seedBase(db);
  });

  afterAll(async () => {
    // اتصال اصلی توسط global teardown بسته می‌شود
  });

  it('اجرای کامل همهٔ jobها با نقش اجرایی food_app و ثبت در job_runs', async () => {
    const appUrl = testAppRoleDatabaseUrl();
    const pool = createPool(appUrl, 4, 'food-worker-test');
    const workerDb = createDb(pool);
    const parsedEnv = readEnv(testEnv({ DATABASE_URL: appUrl }));
    if (!parsedEnv.ok) throw new Error(parsedEnv.issues.join(', '));
    const deps = { db: workerDb, env: parsedEnv.env, log: createSilentLogger() };

    try {
      const summaries = await runAllWorkerJobsOnce(pool, deps, 'worker-test-1');
      expect(summaries).toHaveLength(8);
      expect(summaries.every((s) => s.status === 'Ok')).toBe(true);

      const recorded = await query<{ job: string; status: string; worker_id: string }>(
        db,
        `SELECT job, status, worker_id FROM job_runs ORDER BY started_at ASC`,
      );
      expect(recorded).toHaveLength(8);
      expect(recorded.every((r) => r.status === 'Ok' && r.worker_id === 'worker-test-1')).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('قفل مشورتی (pg_try_advisory_lock): دو worker هم‌زمان هیچ‌گاه کار تکراری انجام نمی‌دهند', async () => {
    const appUrl = testAppRoleDatabaseUrl();
    const poolA = createPool(appUrl, 3, 'food-worker-A');
    const poolB = createPool(appUrl, 3, 'food-worker-B');
    const dbA = createDb(poolA);
    const dbB = createDb(poolB);
    const parsedEnv = readEnv(testEnv({ DATABASE_URL: appUrl }));
    if (!parsedEnv.ok) throw new Error(parsedEnv.issues.join(', '));
    const depsA = { db: dbA, env: parsedEnv.env, log: createSilentLogger() };
    const depsB = { db: dbB, env: parsedEnv.env, log: createSilentLogger() };

    const rawHolder = await openClient(appUrl);
    try {
      // ۱) قفل mark-no-shows (lockId=101) توسط یک اتصال نگه داشته می‌شود ⇒ worker دوم فوراً Skipped می‌شود
      const held = await rawHolder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [20261023, 101]);
      expect(held.rows[0]?.locked).toBe(true);

      const skipped = await runLockedJob(poolB, depsB, 'mark-no-shows', 'worker-B');
      expect(skipped.status).toBe('Skipped');

      await rawHolder.query('SELECT pg_advisory_unlock($1, $2)', [20261023, 101]);

      // ۲) دو worker دقیقاً هم‌زمان روی رزرو منقضی با noshow_refund=true اجرا می‌شوند ⇒ فقط یک بازپرداخت!
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('noshow_refund', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );
      invalidateSettingsCacheForDb(dbA);
      invalidateSettingsCacheForDb(dbB);

      await db.execute(sql`UPDATE meal_slots SET start_time = '00:05:00'::time, end_time = '00:20:00'::time WHERE code = 'Breakfast'`);
      const student = await createStudent(db, { balanceRial: 0 });
      const offering = await createOffering(db, {
        serviceDate: tehranToday(),
        mealSlot: 'Breakfast',
        prices: { Student: 75_000 },
        reserveOpensAt: new Date(Date.now() - 48 * 3_600_000),
        reserveDeadline: new Date(Date.now() - 24 * 3_600_000),
      });

      // ابتدا موجودی حساب سیستمی MEAL_REVENUE و رزرو را مثل یک رزرو واقعی ثبت می‌کنیم
      await db.insert(reservations).values({
        code: `R-${randomHex(4).toUpperCase()}`,
        accountId: student.accountId,
        offeringId: offering.id,
        serviceDate: offering.serviceDate,
        mealSlotId: offering.mealSlotId,
        cafeteriaId: offering.cafeteriaId,
        priceAtBooking: 75_000,
        customerGroupAtBooking: 'Student',
        status: 'Reserved',
        idempotencyKey: randomHex(12),
        qrToken: randomHex(24),
        qrIssuedAt: new Date(),
      });
      await db
        .update(mealOfferings)
        .set({ reservedCount: 1 })
        .where(sql`${mealOfferings.id} = ${offering.id}`);

      const [resA, resB] = await Promise.all([
        runLockedJob(poolA, depsA, 'mark-no-shows', 'worker-A'),
        runLockedJob(poolB, depsB, 'mark-no-shows', 'worker-B'),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // یکی Ok و دیگری یا Skipped (اگر هم‌زمان رسید) یا Ok با marked=0 (اگر پس از اتمام اولی رسید)
      expect(statuses).toContain('Ok');

      const [acc] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [student.accountId]);
      expect(Number(acc?.balance_rial)).toBe(75_000);

      const recon = await reconcileLedger(db);
      expect(recon.unbalancedTransactions).toEqual([]);
      expect(recon.balanceMismatches).toEqual([]);
    } finally {
      await rawHolder.end();
      await poolA.end();
      await poolB.end();
    }
  });
});
