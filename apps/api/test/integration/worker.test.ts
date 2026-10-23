import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { tehranToday } from '@food/shared';
import { createDb, createPool } from '../../src/db/client.js';
import { mealOfferings, reservations } from '../../src/db/schema/index.js';
import { readEnv, testEnv } from '../../src/config/env.js';
import { createSilentLogger } from '../../src/lib/logger.js';
import { randomHex } from '../../src/lib/crypto.js';
import { reconcileLedger } from '../../src/services/ledger.service.js';
import { sendMealReminders } from '../../src/services/reminder.service.js';
import { invalidateSettingsCacheForDb } from '../../src/services/settings.service.js';
import { runAllWorkerJobsOnce, runLockedJob } from '../../src/services/worker-jobs.js';
import { buildTestApp, loginStaff } from '../helpers/app.js';
import { getTestDb, openClient, query, resetDatabase, testAppRoleDatabaseUrl } from '../helpers/db.js';
import { createEmployee, createOffering, createStaff, createStudent, resetBaseCache, seedBase } from '../helpers/fixtures.js';

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
      expect(summaries).toHaveLength(9);
      expect(summaries.every((s) => s.status === 'Ok')).toBe(true);

      const recorded = await query<{ job: string; status: string; worker_id: string }>(
        db,
        `SELECT job, status, worker_id FROM job_runs ORDER BY started_at ASC`,
      );
      expect(recorded).toHaveLength(9);
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

  it('send-meal-reminders: منطقهٔ زمانی تهران، مرز بازهٔ زمانی، تفکیک موبایل/بدون موبایل، رد لغو/تحویل و idempotency اجرای مجدد', async () => {
    const appUrl = testAppRoleDatabaseUrl();
    const pool = createPool(appUrl, 4, 'food-worker-reminder');
    const workerDb = createDb(pool);
    const parsedEnv = readEnv(testEnv({ DATABASE_URL: appUrl }));
    if (!parsedEnv.ok) throw new Error(parsedEnv.issues.join(', '));
    const deps = { db: workerDb, env: parsedEnv.env, log: createSilentLogger() };

    try {
      // ساعت شروع ناهار به وقت تهران: ۱۲:۰۰ (= ۰۸:۳۰:۰۰ UTC)؛ بازهٔ یادآوری: ۲ ساعت قبل از شروع وعده
      await db.execute(sql`UPDATE meal_slots SET start_time = '12:00:00'::time, end_time = '14:00:00'::time WHERE code = 'Lunch'`);
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('reminder_hours_before_meal', to_jsonb('2'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('2'::text)`,
      );
      invalidateSettingsCacheForDb(workerDb);

      const serviceDate = '2026-10-25';
      const offering = await createOffering(db, {
        serviceDate,
        mealSlot: 'Lunch',
        prices: { Student: 80_000, Employee: 120_000 },
        reserveOpensAt: new Date('2026-10-20T00:00:00.000Z'),
        reserveDeadline: new Date('2026-10-24T20:00:00.000Z'),
      });

      const studentReserved = await createStudent(db, { fullName: 'دانشجو بدون موبایل' });
      const empWithMobile = await createEmployee(db, { mobile: '09123456789', customerGroup: 'Employee' });
      const studentCancelled = await createStudent(db, { fullName: 'دانشجو لغوشده' });
      const studentDelivered = await createStudent(db, { fullName: 'دانشجو تحویل‌شده' });

      const insertRes = async (accountId: string, group: 'Student' | 'Employee', status: string, cancelReason: string | null = null) => {
        const [r] = await db
          .insert(reservations)
          .values({
            code: `R-${randomHex(4).toUpperCase()}`,
            accountId,
            offeringId: offering.id,
            serviceDate,
            mealSlotId: offering.mealSlotId,
            cafeteriaId: offering.cafeteriaId,
            priceAtBooking: group === 'Student' ? 80_000 : 120_000,
            customerGroupAtBooking: group,
            status,
            cancelReason,
            idempotencyKey: randomHex(12),
            qrToken: randomHex(24),
            qrIssuedAt: new Date('2026-10-24T12:00:00.000Z'),
          })
          .returning({ id: reservations.id });
        return r!.id;
      };

      await insertRes(studentReserved.accountId, 'Student', 'Reserved');
      await insertRes(empWithMobile.accountId, 'Employee', 'Reserved');
      await insertRes(studentCancelled.accountId, 'Student', 'Cancelled', 'لغو آزمایشی');
      await insertRes(studentDelivered.accountId, 'Student', 'Delivered');

      // ۱) یک ثانیه زودتر از مرز ۲ ساعت قبل از ۱۲:۰۰ تهران (۰۶:۲۹:۵۹ UTC = ۰۹:۵۹:۵۹ تهران) ⇒ هیچ یادآوری ارسال نمی‌شود
      const beforeWindow = await sendMealReminders(deps, new Date('2026-10-25T06:29:59.000Z'));
      expect(beforeWindow.sent).toBe(0);
      expect(beforeWindow.smsQueued).toBe(0);

      // ۲) اگر وعده قبلاً شروع شده باشد (۰۸:۳۰:۰۰ UTC = ۱۲:۰۰:۰۰ تهران) ⇒ ارسال نمی‌شود
      const afterStart = await sendMealReminders(deps, new Date('2026-10-25T08:30:00.000Z'));
      expect(afterStart.sent).toBe(0);

      // ۳) دقیقاً روی مرز ۲ ساعت قبل از شروع وعده به وقت تهران (۰۶:۳۰:۰۰ UTC = ۱۰:۰۰:۰۰ تهران)
      //    ⇒ فقط ۲ رزرو Reserved یادآوری می‌گیرند (لغوشده و تحویل‌شده رد می‌شوند)؛
      //    دانشجو فقط اعلان درون‌برنامه‌ای و کارمند دارای موبایل هم اعلان و هم پیامک در notification_outbox می‌گیرد!
      const inWindow = await sendMealReminders(deps, new Date('2026-10-25T06:30:00.000Z'));
      expect(inWindow.sent).toBe(2);
      expect(inWindow.smsQueued).toBe(1);

      const inAppRows = await query<{ account_id: string; event: string }>(
        db,
        `SELECT account_id, event FROM notifications WHERE event = 'reservation.reminder'`,
      );
      expect(inAppRows).toHaveLength(2);
      expect(inAppRows.map((r) => r.account_id).sort()).toEqual([studentReserved.accountId, empWithMobile.accountId].sort());

      const outboxRows = await query<{ account_id: string; recipient: string; status: string }>(
        db,
        `SELECT account_id, recipient, status FROM notification_outbox`,
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]?.account_id).toBe(empWithMobile.accountId);
      expect(outboxRows[0]?.recipient).toBe('09123456789');
      expect(outboxRows[0]?.status).toBe('Queued');

      // ۴) اجرای دوباره و سه‌باره در همان پنجره (مثلاً ۱۰ دقیقه بعد در ۱۰:۱۰ تهران) ⇒ صفر ارسال تکراری!
      const rerun = await sendMealReminders(deps, new Date('2026-10-25T06:40:00.000Z'));
      expect(rerun.sent).toBe(0);
      expect(rerun.smsQueued).toBe(0);

      const lockedSummary = await runLockedJob(pool, deps, 'send-meal-reminders', 'worker-reminder-lock');
      expect(lockedSummary.status).toBe('Ok');

      const reminderCount = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM reservation_reminders`);
      expect(reminderCount[0]?.n).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('تنظیم reminder_hours_before_meal از مسیر API قابل ویرایش است و مقادیر خارج از بازه رد می‌شوند', async () => {
    const ctx = await buildTestApp();
    try {
      const sa = await createStaff(db, { username: 'sa.reminder', role: 'SuperAdmin' });
      const client = await loginStaff(ctx.app, sa.username, sa.password);

      const okRes = await client.put<{ values: Record<string, string> }>('/api/v1/settings', {
        values: { reminder_hours_before_meal: 4 },
      });
      expect(okRes.status).toBe(200);
      expect(okRes.body.values.reminder_hours_before_meal).toBe('4');

      const badHigh = await client.put('/api/v1/settings', {
        values: { reminder_hours_before_meal: 72 },
      });
      expect(badHigh.status).toBe(400);

      const badNegative = await client.put('/api/v1/settings', {
        values: { reminder_hours_before_meal: -1 },
      });
      expect(badNegative.status).toBe(400);
    } finally {
      await ctx.close();
    }
  });
});
