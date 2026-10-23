import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, openClient, query, resetDatabase } from '../helpers/db.js';
import { buildTestApp, createTestClient, loginStaff, primeCsrf, type TestApp, type TestClient } from '../helpers/app.js';
import {
  createCafeteria,
  createDeliverableOffering,
  createEmployee,
  createFood,
  createOffering,
  createStaff,
  createStudent,
  makeNationalId,
  resetBaseCache,
  seedBase,
} from '../helpers/fixtures.js';
import { accounts, ledgerEntries, ledgerTransactions, mealOfferings, reservations } from '../../src/db/schema/index.js';
import { addDays, tehranDateTimeToUtc, tehranToday } from '@food/shared';
import { randomHex } from '../../src/lib/crypto.js';

/**
 * جریان‌های اصلی کسب‌وکار روی PostgreSQL واقعی:
 * رزرو (اتمیک، ظرفیت، موجودی، تکراری، idempotency، رقابت هم‌زمان)،
 * لغو و بازپرداخت، تحویل و اسکن هم‌زمان، مالی و ناوردایی دفتر کل.
 */

const db = getTestDb();
let ctx: TestApp;

beforeAll(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
  ctx = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'false' });
});

beforeEach(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
});

afterAll(async () => {
  await ctx?.close();
});

const tomorrow = () => addDays(tehranToday(), 1);

/** وعده‌ای که مهلت رزرو آن باز است (شروع وعده فردا، مهلت = لحظهٔ شروع). */
async function openOffering(options: { capacity?: number; price?: number; groups?: Record<string, number> } = {}) {
  return createOffering(db, {
    serviceDate: tomorrow(),
    mealSlot: 'Lunch',
    capacity: options.capacity ?? 10,
    prices: options.groups ?? { Student: options.price ?? 100_000 },
    reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
  });
}

async function loginStudentClient(student: { studentNumber: string; nationalId: string }, userAgent?: string): Promise<TestClient> {
  const client = createTestClient(ctx.app, userAgent ? { userAgent } : {});
  await primeCsrf(client);
  const response = await client.post('/api/v1/auth/student/login', student);
  expect(response.status).toBe(200);
  return client;
}

/** ناوردایی دفتر کل: مجموع هر تراکنش صفر و موجودی = مجموع ورودی‌ها. */
async function assertLedgerInvariants(): Promise<void> {
  const unbalanced = await query<{ transaction_id: string; total: string }>(
    db,
    `SELECT transaction_id, SUM(amount_rial)::text AS total FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_rial) <> 0`,
  );
  expect(unbalanced, 'تراکنش نامتوازن در دفتر کل وجود دارد').toEqual([]);

  const mismatches = await query<{ id: string; cached: string; ledger: string }>(
    db,
    `SELECT a.id, a.balance_rial::text AS cached, COALESCE((SELECT SUM(e.amount_rial) FROM ledger_entries e WHERE e.account_id = a.id),0)::text AS ledger
     FROM accounts a WHERE a.balance_rial <> COALESCE((SELECT SUM(e.amount_rial) FROM ledger_entries e WHERE e.account_id = a.id),0)`,
  );
  expect(mismatches, 'موجودی کش‌شده با دفتر کل نمی‌خواند').toEqual([]);

  const negative = await query<{ id: string }>(db, `SELECT id FROM accounts WHERE balance_rial < 0`);
  expect(negative, 'موجودی منفی وجود دارد').toEqual([]);
}

describe('رزرو', () => {
  it('رزرو موفق: کسر موجودی، افزایش reserved_count و ثبت دفتر کل دوطرفه', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    const offering = await openOffering({ price: 120_000 });
    const client = await loginStudentClient(student);

    const response = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    expect(response.status).toBe(200);
    const body = response.body as { reservationId: string; code: string; priceRial: number; balanceRial: number; replay: boolean };
    expect(body.priceRial).toBe(120_000);
    expect(body.balanceRial).toBe(380_000);
    expect(body.replay).toBe(false);
    expect(body.code).toMatch(/^R-/);

    const [offeringRow] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [
      offering.id,
    ]);
    expect(offeringRow?.reserved_count).toBe(1);

    const entries = await query<{ amount_rial: string; system_account: string | null }>(
      db,
      `SELECT e.amount_rial::text, e.system_account FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.type = 'ReservationDebit'`,
    );
    expect(entries).toHaveLength(2);
    expect(Number(entries[0]?.amount_rial) + Number(entries[1]?.amount_rial)).toBe(0);

    await assertLedgerInvariants();
  });

  it('موجودی ناکافی ⇒ رزرو انجام نمی‌شود و کسری اعلام می‌شود', async () => {
    const student = await createStudent(db, { balanceRial: 50_000 });
    const offering = await openOffering({ price: 120_000 });
    const client = await loginStudentClient(student);

    const response = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    expect(response.status).toBe(402);
    const error = (response.body as { error: { code: string; details?: { shortfallRial?: number } } }).error;
    expect(error.code).toBe('INSUFFICIENT_BALANCE');
    expect(error.details?.shortfallRial).toBe(70_000);

    const [row] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [offering.id]);
    expect(row?.reserved_count).toBe(0);
    const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
      student.accountId,
    ]);
    expect(Number(account?.balance_rial)).toBe(50_000);
    await assertLedgerInvariants();
  });

  it('ظرفیت تکمیل ⇒ رزرو رد می‌شود و موجودی دست‌نخورده می‌ماند', async () => {
    const offering = await openOffering({ capacity: 1, price: 100_000 });
    const first = await createStudent(db, { balanceRial: 200_000 });
    const second = await createStudent(db, { balanceRial: 200_000 });

    const clientA = await loginStudentClient(first);
    expect((await clientA.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) })).status).toBe(200);

    const clientB = await loginStudentClient(second);
    const response = await clientB.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('CAPACITY_FULL');

    const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
      second.accountId,
    ]);
    expect(Number(account?.balance_rial)).toBe(200_000);
    await assertLedgerInvariants();
  });

  it('دو غذای مختلف در ناهار یک روز با یک حساب ⇒ هر دو موفق؛ رزرو دوبارهٔ همان غذا ⇒ خطای DUPLICATE_OFFERING', async () => {
    const student = await createStudent(db, { balanceRial: 1_000_000 });
    const first = await openOffering({ capacity: 10, price: 100_000 });
    const second = await createOffering(db, {
      serviceDate: tomorrow(),
      mealSlot: 'Lunch',
      capacity: 10,
      foodId: await createFood(db, 'غذای دوم'),
      prices: { Student: 150_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
    });
    const client = await loginStudentClient(student);

    const res1 = await client.post('/api/v1/me/reservations', { offeringId: first.id, idempotencyKey: randomHex(8) });
    expect(res1.status).toBe(200);

    // غذای دوم در همان روز و همان وعدهٔ ناهار ⇒ موفق
    const res2 = await client.post('/api/v1/me/reservations', { offeringId: second.id, idempotencyKey: randomHex(8) });
    expect(res2.status).toBe(200);
    expect((res2.body as { code: string }).code).not.toBe((res1.body as { code: string }).code);
    expect((res2.body as { balanceRial: number }).balanceRial).toBe(750_000);

    // رزرو دوبارهٔ همان غذای اول ⇒ ۴۰۹ DUPLICATE_OFFERING
    const dup = await client.post('/api/v1/me/reservations', { offeringId: first.id, idempotencyKey: randomHex(8) });
    expect(dup.status).toBe(409);
    expect((dup.body as { error: { code: string; message: string } }).error.code).toBe('DUPLICATE_OFFERING');
    expect((dup.body as { error: { message: string } }).error.message).toContain('این غذا را قبلاً رزرو کرده‌اید');

    const [row1] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [first.id]);
    const [row2] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [second.id]);
    expect(row1?.reserved_count).toBe(1);
    expect(row2?.reserved_count).toBe(1);
    await assertLedgerInvariants();
  });

  it('idempotency: تکرار همان کلید، اثر دومی ندارد و همان نتیجه را برمی‌گرداند', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    const offering = await openOffering({ price: 100_000 });
    const client = await loginStudentClient(student);
    const key = randomHex(8);

    const first = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: key });
    const second = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { replay: boolean }).replay).toBe(true);
    expect((second.body as { reservationId: string }).reservationId).toBe((first.body as { reservationId: string }).reservationId);

    const [row] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [offering.id]);
    expect(row?.reserved_count).toBe(1);
    const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
      student.accountId,
    ]);
    expect(Number(account?.balance_rial)).toBe(400_000);
    await assertLedgerInvariants();
  });

  it('رقابت هم‌زمان: ۵۰ درخواست برای ظرفیت ۱۰ ⇒ دقیقاً ۱۰ موفق', async () => {
    const offering = await openOffering({ capacity: 10, price: 50_000 });
    const students = await Promise.all(
      Array.from({ length: 50 }, async (_, index) =>
        createStudent(db, { balanceRial: 100_000, nationalId: makeNationalId(900_000 + index), studentNumber: String(500000000 + index) }),
      ),
    );
    const clients = await Promise.all(students.map((s) => loginStudentClient(s)));

    const results = await Promise.all(
      clients.map((client, index) =>
        client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: `race-${index}-${randomHex(4)}` }),
      ),
    );

    const ok = results.filter((r) => r.status === 200).length;
    const full = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(10);
    expect(full).toBe(40);

    const [row] = await query<{ reserved_count: number; capacity: number }>(
      db,
      `SELECT reserved_count, capacity FROM meal_offerings WHERE id = $1`,
      [offering.id],
    );
    expect(row?.reserved_count).toBe(10);
    expect(Number(row?.capacity)).toBe(10);

    const count = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM reservations WHERE offering_id = $1`, [offering.id]);
    expect(count[0]?.n).toBe(10);
    await assertLedgerInvariants();
  });

  it('گروه مشتری بدون قیمت، وعده را نمی‌بیند و نمی‌تواند رزرو کند', async () => {
    const employee = await createEmployee(db, { customerGroup: 'Faculty', balanceRial: 1_000_000 });
    const offering = await openOffering({ groups: { Student: 100_000 } });

    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    const login = await client.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });
    expect(login.status).toBe(200);

    const menu = await client.get<{ offerings: { id: string }[] }>('/api/v1/me/menu', { from: tomorrow(), to: tomorrow() });
    expect(menu.status).toBe(200);
    expect((menu.body as { offerings: unknown[] }).offerings).toHaveLength(0);

    const reserve = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    expect(reserve.status).toBe(403);
    expect((reserve.body as { error: { message: string } }).error.message).toContain('برای شما در دسترس نیست');
  });

  it('کارمند با قیمت گروه خودش رزرو می‌کند', async () => {
    const employee = await createEmployee(db, { customerGroup: 'Faculty', balanceRial: 1_000_000 });
    const offering = await openOffering({ groups: { Student: 100_000, Faculty: 600_000 } });
    const client = createTestClient(ctx.app);
    await primeCsrf(client);
    await client.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });

    const response = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    expect(response.status).toBe(200);
    expect((response.body as { priceRial: number }).priceRial).toBe(600_000);
    expect((response.body as { balanceRial: number }).balanceRial).toBe(400_000);
  });

  it('وعدهٔ منتشرنشده، گذشته و خارج از مهلت قابل رزرو نیست', async () => {
    const student = await createStudent(db, { balanceRial: 1_000_000 });
    const client = await loginStudentClient(student);

    const draft = await createOffering(db, {
      serviceDate: tomorrow(),
      status: 'Draft',
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
    });
    expect((await client.post('/api/v1/me/reservations', { offeringId: draft.id, idempotencyKey: randomHex(8) })).status).toBe(409);

    const past = await createOffering(db, {
      serviceDate: addDays(tehranToday(), -1),
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(tehranToday(), '23:59'),
    });
    const pastResponse = await client.post('/api/v1/me/reservations', { offeringId: past.id, idempotencyKey: randomHex(8) });
    expect(pastResponse.status).toBe(409);

    const closed = await createOffering(db, {
      serviceDate: tomorrow(),
      prices: { Student: 100_000 },
      reserveOpensAt: new Date(Date.now() + 3_600_000),
      reserveDeadline: new Date(Date.now() + 7_200_000),
    });
    const closedResponse = await client.post('/api/v1/me/reservations', { offeringId: closed.id, idempotencyKey: randomHex(8) });
    expect(closedResponse.status).toBe(409);
    expect((closedResponse.body as { error: { message: string } }).error.message).toMatch(/باز می‌شود|مهلت/);

    const expired = await createOffering(db, {
      serviceDate: tomorrow(),
      prices: { Student: 100_000 },
      reserveDeadline: new Date(Date.now() - 60_000),
    });
    const expiredResponse = await client.post('/api/v1/me/reservations', { offeringId: expired.id, idempotencyKey: randomHex(8) });
    expect(expiredResponse.status).toBe(409);
    expect((expiredResponse.body as { error: { message: string } }).error.message).toContain('مهلت رزرو');
  });

  it('سبد خرید: هر آیتم مستقل است و هیچ اعتباری بدون پرداخت ثبت نمی‌شود', async () => {
    const student = await createStudent(db, { balanceRial: 150_000 });
    const cheap = await openOffering({ price: 100_000 });
    const expensive = await createOffering(db, {
      serviceDate: tomorrow(),
      mealSlot: 'Dinner',
      prices: { Student: 200_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '18:00'),
    });
    const client = await loginStudentClient(student);

    const response = await client.post('/api/v1/me/checkout', {
      items: [{ offeringId: cheap.id }, { offeringId: expensive.id }],
      idempotencyKey: randomHex(8),
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      succeeded: number;
      failed: number;
      paidRial: number;
      balanceRial: number;
      shortfallRial: number;
      results: { ok: boolean; errorCode: string | null }[];
    };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.paidRial).toBe(100_000);
    expect(body.shortfallRial).toBe(150_000);
    expect(body.balanceRial).toBe(50_000);
    // هیچ «واریز اعتبار» بدون پرداخت ثبت نشده است
    const credits = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type = 'OnlinePayment'`);
    expect(credits[0]?.n).toBe(0);
    await assertLedgerInvariants();
  });
});

describe('لغو و بازپرداخت', () => {
  it('در نسخهٔ اول لغو توسط دانشجو غیرفعال است (مسیر HTTP حذف شده و سرویس با ۴۰۳ مسدود می‌کند)', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    const offering = await openOffering({ price: 100_000 });
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    const reservationId = (created.body as { reservationId: string }).reservationId;

    // مسیر لغو دانشجو از API حذف شده است
    const removedRoute = await client.post(`/api/v1/me/reservations/${reservationId}/cancel`);
    expect(removedRoute.status).toBe(404);

    // تلاش دانشجو برای فراخوانی مسیر لغو اداری ⇒ ۴۰۳
    const adminRouteAttempt = await client.post(`/api/v1/reservations/${reservationId}/cancel`, { reason: 'تلاش لغو توسط دانشجو' });
    expect(adminRouteAttempt.status).toBe(403);

    // فراخوانی مستقیم سرویس وقتی studentCancellationEnabled=false است ⇒ ۴۰۳ با پیام روشن
    const { cancelOwnReservation } = await import('../../src/services/reservation.service.js');
    const { AppError } = await import('../../src/lib/errors.js');
    await expect(
      cancelOwnReservation(
        { db, env: ctx.env, log: ctx.log },
        {
          auth: {
            kind: 'student',
            sessionId: randomHex(8),
            studentId: student.studentId,
            accountId: student.accountId,
            studentNumber: student.studentNumber,
            fullName: 'دانشجو',
            customerGroup: 'Student',
          },
          reservationId,
          ip: '127.0.0.1',
        },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof AppError && err.status === 403 && err.message.includes('فعال نیست'));

    const [row] = await query<{ status: string }>(db, `SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(row?.status).toBe('Reserved');
    await assertLedgerInvariants();
  });

  it('زیرساخت لغو دانشجو (وقتی student_cancellation_enabled=true شود): بازپرداخت، مهلت شمسی، IDOR و جلوگیری پس از تحویل', async () => {
    const { cancelOwnReservation } = await import('../../src/services/reservation.service.js');
    const { invalidateSettingsCacheForDb } = await import('../../src/services/settings.service.js');
    const { AppError } = await import('../../src/lib/errors.js');

    await db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('student_cancellation_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
    );
    invalidateSettingsCacheForDb(db);

    const student = await createStudent(db, { balanceRial: 500_000 });
    const other = await createStudent(db, { balanceRial: 500_000 });
    const authOf = (s: typeof student) => ({
      kind: 'student' as const,
      sessionId: randomHex(8),
      studentId: s.studentId,
      accountId: s.accountId,
      studentNumber: s.studentNumber,
      fullName: 'دانشجو',
      customerGroup: 'Student' as const,
    });

    // ۱) لغو در مهلت ⇒ بازگشت کامل وجه، ثبت cancelledAt/cancelledBy/cancelReason و کاهش reserved_count
    const offering = await createOffering(db, {
      serviceDate: tomorrow(),
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      cancelDeadline: new Date(Date.now() + 4 * 3_600_000),
    });
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    const reservationId = (created.body as { reservationId: string }).reservationId;

    const cancelled = await cancelOwnReservation(
      { db, env: ctx.env, log: ctx.log },
      { auth: authOf(student), reservationId, ip: '127.0.0.1' },
    );
    expect(cancelled.status).toBe('Cancelled');
    expect(cancelled.refundedRial).toBe(100_000);
    expect(cancelled.balanceRial).toBe(500_000);

    const [resMeta] = await query<{ cancelled_by: string | null; cancel_reason: string | null; cancelled_at: Date | null }>(
      db,
      `SELECT cancelled_by, cancel_reason, cancelled_at FROM reservations WHERE id = $1`,
      [reservationId],
    );
    expect(resMeta?.cancelled_by).toBe(student.studentId);
    expect(resMeta?.cancel_reason).toBeTruthy();
    expect(resMeta?.cancelled_at).toBeTruthy();

    const [offRow] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [offering.id]);
    expect(offRow?.reserved_count).toBe(0);

    // ۲) لغو پس از مهلت ⇒ DEADLINE_PASSED با زمان دقیق شمسی
    const expiredCancelOffering = await createOffering(db, {
      serviceDate: tomorrow(),
      foodId: await createFood(db, 'غذای مهلت‌گذشته'),
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      cancelDeadline: new Date(Date.now() - 2 * 3_600_000),
    });
    const created2 = await client.post('/api/v1/me/reservations', { offeringId: expiredCancelOffering.id, idempotencyKey: randomHex(8) });
    const resId2 = (created2.body as { reservationId: string }).reservationId;
    await expect(
      cancelOwnReservation({ db, env: ctx.env, log: ctx.log }, { auth: authOf(student), reservationId: resId2, ip: '127.0.0.1' }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'DEADLINE_PASSED' &&
        err.message.includes('مهلت لغو') &&
        Boolean((err.details as { deadlineFa?: string } | undefined)?.deadlineFa),
    );

    // ۳) IDOR و جلوگیری پس از تحویل
    const delivOffering = await createDeliverableOffering(db, { capacity: 5, price: 100_000 });
    const created3 = await client.post('/api/v1/me/reservations', { offeringId: delivOffering.id, idempotencyKey: randomHex(8) });
    const resId3 = (created3.body as { reservationId: string }).reservationId;

    await expect(
      cancelOwnReservation({ db, env: ctx.env, log: ctx.log }, { auth: authOf(other), reservationId: resId3, ip: '127.0.0.1' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof AppError && err.status === 404);

    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: delivOffering.cafeteriaId });
    const [qr] = await query<{ qr_token: string }>(db, `SELECT qr_token FROM reservations WHERE id = $1`, [resId3]);
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);
    const delivered = await opClient.post('/api/v1/delivery/confirm', { qrToken: qr!.qr_token });
    expect((delivered.body as { state: string }).state).toBe('delivered');

    await expect(
      cancelOwnReservation({ db, env: ctx.env, log: ctx.log }, { auth: authOf(student), reservationId: resId3, ip: '127.0.0.1' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof AppError && err.status === 409);

    await assertLedgerInvariants();
  });

  it('لغو اداری با دلیل الزامی و بازپرداخت', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    const offering = await openOffering({ price: 100_000 });
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    const reservationId = (created.body as { reservationId: string }).reservationId;

    const manager = await createStaff(db, { role: 'NutritionManager' });
    const managerClient = await loginStaff(ctx.app, manager.username, manager.password);
    const withoutReason = await managerClient.post(`/api/v1/reservations/${reservationId}/cancel`, { reason: 'کم' });
    expect(withoutReason.status).toBe(400);

    const cancelled = await managerClient.post(`/api/v1/reservations/${reservationId}/cancel`, { reason: 'مشکل در پخش غذا' });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { refundedRial: number }).refundedRial).toBe(100_000);
    await assertLedgerInvariants();
  });

  it('«تمام شد» و «لغو وعده» همهٔ رزروها را با بازپرداخت لغو می‌کنند (دسته‌ای)', async () => {
    const offering = await openOffering({ capacity: 120, price: 100_000 });
    const students = await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        createStudent(db, { balanceRial: 200_000, studentNumber: String(600000000 + index), nationalId: makeNationalId(700_000 + index) }),
      ),
    );
    const clients = await Promise.all(students.map((s) => loginStudentClient(s)));
    const reserved = await Promise.all(
      clients.map((c, i) => c.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: `bulk-key-${i}-xyz` })),
    );
    expect(reserved.filter((r) => r.status === 200)).toHaveLength(120);

    const manager = await createStaff(db, { role: 'NutritionManager' });
    const managerClient = await loginStaff(ctx.app, manager.username, manager.password);

    // بدون تأیید تایپی رد می‌شود
    const needsConfirm = await managerClient.patch(`/api/v1/offerings/${offering.id}/status`, {
      status: 'Cancelled',
      reason: 'خرابی تجهیزات آشپزخانه',
    });
    expect(needsConfirm.status).toBe(400);

    const cancelled = await managerClient.patch(`/api/v1/offerings/${offering.id}/status`, {
      status: 'Cancelled',
      reason: 'خرابی تجهیزات آشپزخانه',
      confirmText: 'لغو وعده',
    });
    expect(cancelled.status).toBe(200);
    const body = cancelled.body as { cancelledReservations: number; refundedRial: number; notified: number; failed: number };
    expect(body.cancelledReservations).toBe(120);
    expect(body.refundedRial).toBe(120 * 100_000);
    expect(body.notified).toBe(120);
    expect(body.failed).toBe(0);

    const statuses = await query<{ n: number }>(
      db,
      `SELECT COUNT(*)::int AS n FROM reservations WHERE offering_id = $1 AND status = 'Cancelled'`,
      [offering.id],
    );
    expect(statuses[0]?.n).toBe(120);
    const [row] = await query<{ reserved_count: number; status: string }>(
      db,
      `SELECT reserved_count, status FROM meal_offerings WHERE id = $1`,
      [offering.id],
    );
    expect(row?.reserved_count).toBe(0);
    expect(row?.status).toBe('Cancelled');

    // هر دانشجو مبلغ کامل را پس گرفته است
    const balances = await query<{ min: string }>(db, `SELECT MIN(balance_rial)::text AS min FROM accounts`);
    expect(Number(balances[0]?.min)).toBe(200_000);
    await assertLedgerInvariants();
  });
});

describe('تحویل و QR', () => {
  /** رزرو روی وعدهٔ «امروز» که بازهٔ اسکن آن اکنون باز است. */
  async function reserveAndLogin() {
    const student = await createStudent(db, { balanceRial: 500_000 });
    const offering = await createDeliverableOffering(db, { price: 100_000 });
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    expect(created.status, `رزرو ناموفق: ${created.raw}`).toBe(200);
    const [row] = await query<{ qr_token: string; code: string }>(db, `SELECT qr_token, code FROM reservations WHERE id = $1`, [
      (created.body as { reservationId: string }).reservationId,
    ]);
    return {
      student,
      offering,
      client,
      reservationId: (created.body as { reservationId: string }).reservationId,
      qrToken: row!.qr_token,
      code: row!.code,
    };
  }

  it('اسکن معتبر، تحویل اتمیک و رد شدن اسکن دوم', async () => {
    const { offering, qrToken, code } = await reserveAndLogin();
    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);

    const scan = await opClient.post('/api/v1/delivery/scan', { qrToken });
    expect(scan.status).toBe(200);
    expect((scan.body as { state: string }).state).toBe('ready');

    const confirm = await opClient.post('/api/v1/delivery/confirm', { qrToken });
    expect(confirm.status).toBe(200);
    expect((confirm.body as { state: string }).state).toBe('delivered');
    expect((confirm.body as { message: string }).message).toContain('تحویل داده شد');

    const second = await opClient.post('/api/v1/delivery/confirm', { qrToken });
    expect((second.body as { state: string }).state).toBe('already');
    expect((second.body as { message: string }).message).toContain('قبلاً');

    // ورود دستی با کد رزرو هم کار می‌کند (بدون پیشوند R-)
    const manual = await opClient.post('/api/v1/delivery/scan', { qrToken: code.replace(/^R-/, '') });
    expect((manual.body as { state: string }).state).toBe('already');
  });

  it('دو اسکن هم‌زمان ⇒ فقط یک تحویل موفق', async () => {
    const { offering, qrToken } = await reserveAndLogin();
    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);

    const results = await Promise.all([
      opClient.post('/api/v1/delivery/confirm', { qrToken }),
      opClient.post('/api/v1/delivery/confirm', { qrToken }),
      opClient.post('/api/v1/delivery/confirm', { qrToken }),
    ]);
    const delivered = results.filter((r) => (r.body as { state: string }).state === 'delivered').length;
    expect(delivered).toBe(1);

    const rows = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM deliveries WHERE outcome = 'Accepted'`);
    expect(rows[0]?.n).toBe(1);
    const status = await query<{ status: string }>(db, `SELECT status FROM reservations`);
    expect(status[0]?.status).toBe('Delivered');
  });

  it('کد نامعتبر، رزرو لغوشده، سلف اشتباه و روز اشتباه', async () => {
    const { offering, qrToken, reservationId } = await reserveAndLogin();
    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);

    const invalid = await opClient.post('/api/v1/delivery/scan', { qrToken: 'not-a-token' });
    expect((invalid.body as { state: string }).state).toBe('invalid');

    // سلف اشتباه
    const otherCafeteria = await createCafeteria(db, 'سلف دیگر');
    const otherOperator = await createStaff(db, { username: 'op.other', role: 'Operator', cafeteriaId: otherCafeteria });
    const otherClient = await loginStaff(ctx.app, otherOperator.username, otherOperator.password);
    const wrong = await otherClient.post('/api/v1/delivery/scan', { qrToken });
    expect((wrong.body as { state: string }).state).toBe('wrongCafeteria');

    // رزرو لغوشده
    await db
      .update(reservations)
      .set({ status: 'Cancelled', cancelReason: 'تست' })
      .where(sql`${reservations.id} = ${reservationId}`);
    const cancelled = await opClient.post('/api/v1/delivery/scan', { qrToken });
    expect((cancelled.body as { state: string }).state).toBe('cancelled');

    // همهٔ تلاش‌ها در deliveries ثبت شده‌اند
    const attempts = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM deliveries`);
    expect(Number(attempts[0]?.n)).toBeGreaterThanOrEqual(3);
  });

  it('خارج از بازهٔ اسکن ⇒ outsideWindow با پیام فارسی', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    // وعدهٔ امروز با بازهٔ اسکنی که تمام شده است
    const offering = await createOffering(db, {
      serviceDate: tehranToday(),
      mealSlot: 'Breakfast',
      prices: { Student: 100_000 },
      reserveOpensAt: new Date(Date.now() - 24 * 3_600_000),
      reserveDeadline: new Date(Date.now() - 6 * 3_600_000),
    });
    // رزرو مستقیم (چون مهلت رزرو گذشته است)
    const [reservation] = await db
      .insert(reservations)
      .values({
        code: `R-${randomHex(4).toUpperCase()}`,
        accountId: student.accountId,
        offeringId: offering.id,
        serviceDate: offering.serviceDate,
        mealSlotId: offering.mealSlotId,
        cafeteriaId: offering.cafeteriaId,
        priceAtBooking: 100_000,
        customerGroupAtBooking: 'Student',
        status: 'Reserved',
        idempotencyKey: randomHex(12),
        qrToken: randomHex(24),
        qrIssuedAt: new Date(),
      })
      .returning({ id: reservations.id, qrToken: reservations.qrToken });

    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);
    const scan = await opClient.post('/api/v1/delivery/scan', { qrToken: reservation!.qrToken });
    expect(['outsideWindow', 'expired']).toContain((scan.body as { state: string }).state);
  });

  it('بازصدور QR: توکن جدید کار می‌کند و توکن قبلی باطل است', async () => {
    const { offering, qrToken, client, reservationId } = await reserveAndLogin();
    const reissued = await client.post(`/api/v1/me/reservations/${reservationId}/qr/reissue`);
    expect(reissued.status).toBe(200);
    const newToken = (reissued.body as { qrToken: string }).qrToken;
    expect(newToken).not.toBe(qrToken);

    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);
    const old = await opClient.post('/api/v1/delivery/scan', { qrToken });
    expect((old.body as { state: string }).state).toBe('invalid');
    const fresh = await opClient.post('/api/v1/delivery/scan', { qrToken: newToken });
    expect((fresh.body as { state: string }).state).toBe('ready');
  });

  it('فهرست آفلاین فقط hash توکن را برمی‌گرداند و همگام‌سازی idempotent است', async () => {
    const { offering, qrToken, reservationId } = await reserveAndLogin();

    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);

    const manifest = await opClient.get<{ reservations: { reservationId: string; qrTokenHash: string }[] }>(
      '/api/v1/delivery/offline-manifest',
    );
    expect(manifest.status).toBe(200);
    const list = (manifest.body as { reservations: { reservationId: string; qrTokenHash: string }[] }).reservations;
    expect(list.length).toBe(1);
    expect(list[0]!.qrTokenHash).not.toBe(qrToken);
    expect(manifest.raw).not.toContain(qrToken);

    const event = {
      clientEventId: randomHex(12),
      reservationId: list[0]!.reservationId,
      qrTokenHash: list[0]!.qrTokenHash,
      scannedAt: new Date().toISOString(),
      deviceId: 'test-device',
    };
    const sync = await opClient.post('/api/v1/delivery/sync', { events: [event] });
    expect(sync.status).toBe(200);
    expect((sync.body as { accepted: number }).accepted).toBe(1);

    // تکرار همان رویداد ⇒ duplicate، بدون اثر دوم
    const again = await opClient.post('/api/v1/delivery/sync', { events: [event] });
    expect((again.body as { accepted: number }).accepted).toBe(0);
    const statuses = await query<{ status: string }>(db, `SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(statuses[0]?.status).toBe('Delivered');
  });

  it('همگام‌سازی آفلاین برای رزرو لغوشده ⇒ OfflineConflict', async () => {
    const { offering, reservationId, qrToken } = await reserveAndLogin();
    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);
    const manifest = await opClient.get<{ reservations: { qrTokenHash: string }[] }>('/api/v1/delivery/offline-manifest');
    const hash = (manifest.body as { reservations: { qrTokenHash: string }[] }).reservations[0]!.qrTokenHash;

    // در فاصلهٔ آفلاین، رزرو لغو می‌شود
    await db
      .update(reservations)
      .set({ status: 'Cancelled', cancelReason: 'لغو در فاصلهٔ آفلاین' })
      .where(sql`${reservations.id} = ${reservationId}`);

    const sync = await opClient.post('/api/v1/delivery/sync', {
      events: [{ clientEventId: randomHex(12), reservationId, qrTokenHash: hash, scannedAt: new Date().toISOString(), deviceId: 'd1' }],
    });
    expect((sync.body as { conflict: number }).conflict).toBe(1);
    expect(qrToken).toBeTruthy();
    const conflicts = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM deliveries WHERE outcome = 'OfflineConflict'`);
    expect(conflicts[0]?.n).toBe(1);
  });
});

describe('مالی و دفتر کل', () => {
  it('شارژ دستی توسط امور مالی با دلیل، سقف و idempotency', async () => {
    const student = await createStudent(db);
    const finance = await createStaff(db, { role: 'Finance' });
    const client = await loginStaff(ctx.app, finance.username, finance.password);
    const key = randomHex(8);

    const credit = await client.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: student.studentNumber,
      direction: 'credit',
      amountRial: 500_000,
      reason: 'شارژ دستی تست',
      idempotencyKey: key,
    });
    expect(credit.status).toBe(200);
    expect((credit.body as { balanceRial: number }).balanceRial).toBe(500_000);
    expect((credit.body as { trackingCode: string }).trackingCode).toMatch(/^TX-/);

    const replay = await client.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: student.studentNumber,
      direction: 'credit',
      amountRial: 500_000,
      reason: 'شارژ دستی تست',
      idempotencyKey: key,
    });
    expect((replay.body as { replay: boolean }).replay).toBe(true);
    expect((replay.body as { balanceRial: number }).balanceRial).toBe(500_000);

    const withoutReason = await client.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: student.studentNumber,
      direction: 'credit',
      amountRial: 10_000,
      reason: 'کم',
      idempotencyKey: randomHex(8),
    });
    expect(withoutReason.status).toBe(400);

    const overLimit = await client.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: student.studentNumber,
      direction: 'credit',
      amountRial: 999_000_000_000,
      reason: 'بیش از سقف مجاز',
      idempotencyKey: randomHex(8),
    });
    expect(overLimit.status).toBe(400);

    const negative = await client.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: student.studentNumber,
      direction: 'debit',
      amountRial: 900_000,
      reason: 'برداشت بیش از موجودی',
      idempotencyKey: randomHex(8),
    });
    expect(negative.status).toBe(402);
    await assertLedgerInvariants();
  });

  it('مدیر ارشد نمی‌تواند شارژ دستی انجام دهد (تفکیک وظایف)', async () => {
    const student = await createStudent(db);
    const admin = await createStaff(db, { role: 'SuperAdmin' });
    const client = await loginStaff(ctx.app, admin.username, admin.password);
    const response = await client.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: student.studentNumber,
      direction: 'credit',
      amountRial: 100_000,
      reason: 'تست تفکیک وظایف',
      idempotencyKey: randomHex(8),
    });
    expect(response.status).toBe(403);
  });

  it('دفتر کل: UPDATE/DELETE از طریق API ممکن نیست و تطبیق سالم گزارش می‌شود', async () => {
    const student = await createStudent(db, { balanceRial: 300_000 });
    const finance = await createStaff(db, { role: 'Finance' });
    const client = await loginStaff(ctx.app, finance.username, finance.password);

    const reconcile = await client.get('/api/v1/finance/reconcile');
    expect(reconcile.status).toBe(200);
    const body = reconcile.body as { unbalancedTransactions: unknown[]; balanceMismatches: unknown[]; checkedAccounts: number };
    expect(body.unbalancedTransactions).toEqual([]);
    expect(body.balanceMismatches).toEqual([]);
    expect(body.checkedAccounts).toBeGreaterThan(0);

    // تلاش برای دستکاری مستقیم دفتر کل در سطح دیتابیس هم رد می‌شود
    const appClient = await openClient();
    await expect(appClient.query(`UPDATE ledger_entries SET amount_rial = 1 WHERE account_id = $1`, [student.accountId])).rejects.toThrow(
      /append-only|permission denied/i,
    );
    await appClient.end();
  });

  it('شارژ مستقیم کیف پول و برداشت شبا حذف شده‌اند و DATA_ENCRYPTION_KEY اختیاری است', async () => {
    const student = await createStudent(db, { balanceRial: 250_000 });
    const client = await loginStudentClient(student);

    // مسیرهای شارژ مستقیم کیف پول و برداشت بانکی حذف شده‌اند
    const topupRemoved = await client.post('/api/v1/me/wallet/topup', { amountRial: 500_000, returnTo: '/wallet' });
    expect(topupRemoved.status).toBe(404);

    const withdrawRemoved = await client.post('/api/v1/me/withdrawals', { amountRial: 100_000, iban: 'IR820540102680020817909002' });
    expect(withdrawRemoved.status).toBe(404);

    const finance = await createStaff(db, { role: 'Finance' });
    const finClient = await loginStaff(ctx.app, finance.username, finance.password);
    const finWithdrawalsRemoved = await finClient.get('/api/v1/finance/withdrawals');
    expect(finWithdrawalsRemoved.status).toBe(404);

    // کیف پول داخلی فقط موجودی اعتبار بازگشتی و گردش دفتر کل را برمی‌گرداند
    const wallet = await client.get<{ balanceRial: number; transactions: unknown[] }>('/api/v1/me/wallet');
    expect(wallet.status).toBe(200);
    expect((wallet.body as { balanceRial: number }).balanceRial).toBe(250_000);
    expect('withdrawalEnabled' in (wallet.body as Record<string, unknown>)).toBe(false);
    expect('minTopupRial' in (wallet.body as Record<string, unknown>)).toBe(false);

    // DATA_ENCRYPTION_KEY در تنظیمات محیطی اختیاری است
    const { readEnv, testEnv } = await import('../../src/config/env.js');
    const envWithoutEnc = testEnv({ DATA_ENCRYPTION_KEY: '' });
    const parsed = readEnv(envWithoutEnc);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.env.DATA_ENCRYPTION_KEY).toBeUndefined();

    // جلوگیری از open redirect در مسیر بازگشت
    const { sanitizeReturnTo } = await import('../../src/services/payment.service.js');
    expect(sanitizeReturnTo('https://evil.example.com/x')).toBe('/wallet');
    expect(sanitizeReturnTo('//evil.example.com')).toBe('/wallet');
    expect(sanitizeReturnTo('/reservations')).toBe('/reservations');

    await assertLedgerInvariants();
  });

  it('پرداخت مستقیم درگاه غیرفعال ⇒ checkout/start خطای PAYMENT_GATEWAY_DISABLED می‌دهد؛ ولی با اعتبار کامل بدون درگاه رزرو می‌شود', async () => {
    const offering1 = await openOffering({ price: 50_000 });
    const offering2 = await createOffering(db, {
      serviceDate: tomorrow(),
      foodId: await createFood(db, 'خوراک جوجه'),
      prices: { Student: 60_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
    });

    // ۱) دانشجو بدون اعتبار و درگاه خاموش ⇒ ۴۰۹ بدون رزرو و بدون اعتبار رایگان
    const studentNoCredit = await createStudent(db, { balanceRial: 0 });
    const clientNoCredit = await loginStudentClient(studentNoCredit);
    const blocked = await clientNoCredit.post('/api/v1/payments/checkout/start', {
      items: [{ offeringId: offering1.id }],
      idempotencyKey: randomHex(8),
    });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: { code: string } }).error.code).toBe('PAYMENT_GATEWAY_DISABLED');

    // ۲) دانشجو با اعتبار بازگشتی کافی (payable = 0) ⇒ رزرو فوری و اتمیک حتی وقتی درگاه خاموش است
    const studentWithCredit = await createStudent(db, { balanceRial: 150_000 });
    const clientWithCredit = await loginStudentClient(studentWithCredit);
    const idem = randomHex(8);
    const instant = await clientWithCredit.post('/api/v1/payments/checkout/start', {
      items: [{ offeringId: offering1.id }, { offeringId: offering2.id }],
      idempotencyKey: idem,
    });
    expect(instant.status).toBe(200);
    const body = instant.body as {
      mode: string;
      payableRial: number;
      creditUsedRial: number;
      balanceRial: number;
      items: { ok: boolean; code: string | null }[];
    };
    expect(body.mode).toBe('instant');
    expect(body.payableRial).toBe(0);
    expect(body.creditUsedRial).toBe(110_000);
    expect(body.balanceRial).toBe(40_000);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.ok && i.code)).toBe(true);

    // بازپخش همان کلید idempotency ⇒ بدون کسر مجدد
    const replay = await clientWithCredit.post('/api/v1/payments/checkout/start', {
      items: [{ offeringId: offering1.id }, { offeringId: offering2.id }],
      idempotencyKey: idem,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { replay: boolean; balanceRial: number }).replay).toBe(true);
    expect((replay.body as { balanceRial: number }).balanceRial).toBe(40_000);

    await assertLedgerInvariants();
  });

  it('پرداخت مستقیم درگاه: کسر خودکار اعتبار جزئی، حداقل ۱۰٬۰۰۰ ریال شاپرک، callback هم‌زمان و رسید مالکیت‌دار', async () => {
    const sandboxApp = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'true', ALLOW_SANDBOX_GATEWAY: 'true' });
    try {
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );

      // الف) اعتبار ۴۵٬۰۰۰ ریال برای غذای ۵۰٬۰۰۰ ریالی ⇒ مابه‌التفاوت ۵٬۰۰۰ < ۱۰٬۰۰۰ ⇒ پرداخت درگاه ۱۰٬۰۰۰ و ماندن ۵٬۰۰۰ ریال در کیف پول
      const offeringA = await openOffering({ price: 50_000 });
      const studentMinEdge = await createStudent(db, { balanceRial: 45_000 });
      const clientMin = createTestClient(sandboxApp.app);
      await primeCsrf(clientMin);
      await clientMin.post('/api/v1/auth/student/login', {
        studentNumber: studentMinEdge.studentNumber,
        nationalId: studentMinEdge.nationalId,
      });

      const startMin = await clientMin.post('/api/v1/payments/checkout/start', {
        items: [{ offeringId: offeringA.id }],
        idempotencyKey: randomHex(8),
      });
      expect(startMin.status).toBe(200);
      const minBody = startMin.body as {
        mode: string;
        paymentId: string;
        payableRial: number;
        creditUsedRial: number;
        creditRemainingNote: string | null;
      };
      expect(minBody.mode).toBe('gateway');
      expect(minBody.payableRial).toBe(10_000);
      expect(minBody.creditUsedRial).toBe(40_000);
      expect(minBody.creditRemainingNote).toBeTruthy();

      // سه callback هم‌زمان بدون کوکی نشست (عمومی)
      const cbUrl = `/api/v1/payments/zarinpal/callback?paymentId=${minBody.paymentId}&Status=OK`;
      const cbRes = await Promise.all([
        createTestClient(sandboxApp.app).raw('GET', cbUrl),
        createTestClient(sandboxApp.app).raw('GET', cbUrl),
        createTestClient(sandboxApp.app).raw('GET', cbUrl),
      ]);
      expect(cbRes.every((r) => r.status === 303)).toBe(true);

      // دقیقاً یک تراکنش OnlinePayment و یک رزرو ثبت شده و ۵٬۰۰۰ ریال اعتبار دست‌نخورده باقی مانده است
      const resResult = await clientMin.post('/api/v1/payments/result', { paymentId: minBody.paymentId });
      expect(resResult.status).toBe(200);
      const receipt = resResult.body as {
        status: string;
        amountRial: number;
        creditUsedRial: number;
        refundedToWalletRial: number;
        balanceRial: number;
        items: { ok: boolean; code: string | null }[];
      };
      expect(receipt.status).toBe('Paid');
      expect(receipt.amountRial).toBe(10_000);
      expect(receipt.creditUsedRial).toBe(40_000);
      expect(receipt.refundedToWalletRial).toBe(0);
      expect(receipt.balanceRial).toBe(5_000);
      expect(receipt.items).toHaveLength(1);
      expect(receipt.items[0]?.ok).toBe(true);

      // دانشجوی دیگر به رسید دسترسی ندارد (IDOR ⇒ ۴۰۴)
      const stranger = await createStudent(db);
      const strangerClient = createTestClient(sandboxApp.app);
      await primeCsrf(strangerClient);
      await strangerClient.post('/api/v1/auth/student/login', {
        studentNumber: stranger.studentNumber,
        nationalId: stranger.nationalId,
      });
      const idor = await strangerClient.post('/api/v1/payments/result', { paymentId: minBody.paymentId });
      expect(idor.status).toBe(404);

      await assertLedgerInvariants();
    } finally {
      await sandboxApp.close();
    }
  });

  it('تکمیل ظرفیت یکی از آیتم‌ها حین حضور در درگاه ⇒ رزرو آیتم سالم + انتقال دقیق مابقی به اعتبار کیف پول', async () => {
    const sandboxApp = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'true', ALLOW_SANDBOX_GATEWAY: 'true' });
    try {
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );

      const itemAvailable = await createOffering(db, {
        serviceDate: tomorrow(),
        foodId: await createFood(db, 'قورمه‌سبزی'),
        capacity: 5,
        prices: { Student: 50_000 },
        reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      });
      const itemLastSpot = await createOffering(db, {
        serviceDate: tomorrow(),
        foodId: await createFood(db, 'کباب بختیاری'),
        capacity: 1,
        prices: { Student: 60_000 },
        reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      });

      const studentA = await createStudent(db, { balanceRial: 0 });
      const studentB = await createStudent(db, { balanceRial: 100_000 });

      const clientA = createTestClient(sandboxApp.app);
      await primeCsrf(clientA);
      await clientA.post('/api/v1/auth/student/login', { studentNumber: studentA.studentNumber, nationalId: studentA.nationalId });

      // دانشجوی الف پرداخت هر دو آیتم (۱۱۰٬۰۰۰ ریال) را شروع می‌کند
      const started = await clientA.post('/api/v1/payments/checkout/start', {
        items: [{ offeringId: itemAvailable.id }, { offeringId: itemLastSpot.id }],
        idempotencyKey: randomHex(8),
      });
      expect(started.status).toBe(200);
      const paymentId = (started.body as { paymentId: string }).paymentId;

      // در حالی که دانشجوی الف در صفحهٔ بانک است، دانشجوی ب آخرین ظرفیت آیتم دوم را می‌گیرد!
      const clientB = createTestClient(sandboxApp.app);
      await primeCsrf(clientB);
      await clientB.post('/api/v1/auth/student/login', { studentNumber: studentB.studentNumber, nationalId: studentB.nationalId });
      const sniped = await clientB.post('/api/v1/me/reservations', { offeringId: itemLastSpot.id, idempotencyKey: randomHex(8) });
      expect(sniped.status).toBe(200);

      // بازگشت موفق دانشجوی الف از درگاه
      const cb = await createTestClient(sandboxApp.app).raw('GET', `/api/v1/payments/zarinpal/callback?paymentId=${paymentId}&Status=OK`);
      expect(cb.status).toBe(303);

      const res = await clientA.post('/api/v1/payments/result', { paymentId });
      expect(res.status).toBe(200);
      const receipt = res.body as {
        status: string;
        refundedToWalletRial: number;
        balanceRial: number;
        items: { offeringId: string; ok: boolean; errorCode: string | null }[];
      };
      expect(receipt.status).toBe('Paid');
      expect(receipt.refundedToWalletRial).toBe(60_000);
      expect(receipt.balanceRial).toBe(60_000);
      expect(receipt.items.find((i) => i.offeringId === itemAvailable.id)?.ok).toBe(true);
      expect(receipt.items.find((i) => i.offeringId === itemLastSpot.id)?.ok).toBe(false);
      expect(receipt.items.find((i) => i.offeringId === itemLastSpot.id)?.errorCode).toBe('CAPACITY_FULL');

      await assertLedgerInvariants();
    } finally {
      await sandboxApp.close();
    }
  });

  it('لبهٔ درگاه: استعلام verify حتی در Status=NOK، مغایرت مبلغ، خطای داخلی پس از verify (NeedsReview + هشدار مالی) و آشتی‌سازی', async () => {
    const sandboxApp = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'true', ALLOW_SANDBOX_GATEWAY: 'true' });
    try {
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );
      const finance = await createStaff(db, { role: 'Finance' });
      const superAdmin = await createStaff(db, { role: 'SuperAdmin' });

      const offering = await openOffering({ capacity: 10, price: 80_000 });
      const student = await createStudent(db, { balanceRial: 0 });
      const client = createTestClient(sandboxApp.app);
      await primeCsrf(client);
      await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });

      let verifyCalls = 0;
      let verifyMode: 'fail' | 'ok' | 'mismatch' = 'fail';
      sandboxApp.app.deps.gatewayOverride = {
        name: 'sandbox',
        async request({ amountRial }) {
          const authority = `custom_${randomHex(8)}`;
          return { redirectUrl: `/api/v1/payments/sandbox/redirect?authority=${authority}&amount=${amountRial}`, authority };
        },
        async verify({ amountRial }) {
          verifyCalls += 1;
          if (verifyMode === 'fail') return { ok: false, code: -51, message: 'لغو توسط کاربر' };
          if (verifyMode === 'mismatch') return { ok: true, code: 100, refId: 'REF-MISMATCH', amountRial: amountRial - 1_000 };
          return { ok: true, code: 100, refId: 'REF-PAID-100', amountRial };
        },
      };

      // ۱) Status=NOK واقعی: verify فراخوانی می‌شود و پرداخت Failed می‌گردد
      const p1 = await client.post('/api/v1/payments/checkout/start', {
        items: [{ offeringId: offering.id }],
        idempotencyKey: randomHex(8),
      });
      const pid1 = (p1.body as { paymentId: string }).paymentId;
      await createTestClient(sandboxApp.app).raw('GET', `/api/v1/payments/zarinpal/callback?paymentId=${pid1}&Status=NOK`);
      expect(verifyCalls).toBe(1);
      const [row1] = await query<{ status: string }>(db, `SELECT status FROM payments WHERE id = $1`, [pid1]);
      expect(row1?.status).toBe('Failed');

      // ۲) Status=NOK دستکاری‌شده ولی درگاه واقعاً تأیید می‌کند (code=100) ⇒ پرداخت Paid و رزرو ثبت می‌شود!
      verifyMode = 'ok';
      const p2 = await client.post('/api/v1/payments/checkout/start', {
        items: [{ offeringId: offering.id }],
        idempotencyKey: randomHex(8),
      });
      const pid2 = (p2.body as { paymentId: string }).paymentId;
      await createTestClient(sandboxApp.app).raw('GET', `/api/v1/payments/zarinpal/callback?paymentId=${pid2}&Status=NOK`);
      expect(verifyCalls).toBe(2);
      const [row2] = await query<{ status: string }>(db, `SELECT status FROM payments WHERE id = $1`, [pid2]);
      expect(row2?.status).toBe('Paid');

      // ۳) مغایرت مبلغ درگاه ⇒ NeedsReview + اعلان هشدار برای Finance و SuperAdmin
      const offering2 = await createOffering(db, {
        serviceDate: tomorrow(),
        foodId: await createFood(db, 'خورش قیمه'),
        prices: { Student: 70_000 },
        reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      });
      verifyMode = 'mismatch';
      const p3 = await client.post('/api/v1/payments/checkout/start', {
        items: [{ offeringId: offering2.id }],
        idempotencyKey: randomHex(8),
      });
      const pid3 = (p3.body as { paymentId: string }).paymentId;
      await createTestClient(sandboxApp.app).raw('GET', `/api/v1/payments/zarinpal/callback?paymentId=${pid3}&Status=OK`);
      const [row3] = await query<{ status: string; last_error: string }>(db, `SELECT status, last_error FROM payments WHERE id = $1`, [
        pid3,
      ]);
      expect(row3?.status).toBe('NeedsReview');
      expect(row3?.last_error).toBe('amount_mismatch');

      const alerts = await query<{ staff_user_id: string }>(
        db,
        `SELECT staff_user_id FROM notifications WHERE audience = 'Staff' AND event = 'system.alert'`,
      );
      const alertedIds = alerts.map((a) => a.staff_user_id);
      expect(alertedIds).toContain(finance.id);
      expect(alertedIds).toContain(superAdmin.id);

      // ۴) خطای داخلی پس از verify موفق ⇒ NeedsReview با settlement_failed و سپس ترمیم با reconcilePendingPayments
      const offering3 = await createOffering(db, {
        serviceDate: tomorrow(),
        foodId: await createFood(db, 'ماکارونی'),
        prices: { Student: 65_000 },
        reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      });
      verifyMode = 'ok';
      const p4 = await client.post('/api/v1/payments/checkout/start', {
        items: [{ offeringId: offering3.id }],
        idempotencyKey: randomHex(8),
      });
      const pid4 = (p4.body as { paymentId: string }).paymentId;

      const { settleVerifiedPayment, reconcilePendingPayments } = await import('../../src/services/payment.service.js');
      const simFail = await settleVerifiedPayment(sandboxApp.app.deps, {
        paymentId: pid4,
        refId: 'REF-ERR-1',
        gatewayName: 'sandbox',
        ip: '127.0.0.1',
        forceSimulateInternalError: true,
      });
      expect(simFail.status).toBe('needs_review');
      const [row4Before] = await query<{ status: string; last_error: string }>(
        db,
        `SELECT status, last_error FROM payments WHERE id = $1`,
        [pid4],
      );
      expect(row4Before?.status).toBe('NeedsReview');
      expect(row4Before?.last_error).toBe('settlement_failed');

      // اجرای job آشتی‌سازی ⇒ پرداخت تأییدشده تسویه و Paid می‌شود
      const recon = await reconcilePendingPayments(sandboxApp.app.deps, 30);
      expect(recon.needsReviewRetried).toBe(1);
      const [row4After] = await query<{ status: string }>(db, `SELECT status FROM payments WHERE id = $1`, [pid4]);
      expect(row4After?.status).toBe('Paid');

      // ۵) پنل مالی NeedsReview را می‌بیند و می‌تواند تعیین تکلیف کند
      const finClient = await loginStaff(sandboxApp.app, finance.username, finance.password);
      const finList = await finClient.get<{ needsReviewCount: number }>('/api/v1/finance/payments?status=NeedsReview');
      expect(finList.status).toBe(200);
      expect((finList.body as { needsReviewCount: number }).needsReviewCount).toBe(1); // pid3
      const resolved = await finClient.post(`/api/v1/finance/payments/${pid3}/resolve`, {
        action: 'mark_failed',
        reason: 'مغایرت مبلغ با شاپرک بررسی و وجه عودت داده شد',
      });
      expect(resolved.status).toBe(200);

      await assertLedgerInvariants();
    } finally {
      await sandboxApp.close();
    }
  });
});

describe('NoShow و تنظیمات', () => {
  it('رزرو تحویل‌نشده پس از فرجه ⇒ NoShow بدون بازگشت وجه', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    // وعدهٔ صبحانهٔ امروز را به گذشته می‌بریم تا فرجهٔ عدم مراجعه تمام شده باشد
    await db.execute(sql`UPDATE meal_slots SET start_time = '00:05:00'::time, end_time = '00:35:00'::time WHERE code = 'Breakfast'`);
    const offering = await createOffering(db, {
      serviceDate: tehranToday(),
      mealSlot: 'Breakfast',
      prices: { Student: 100_000 },
      reserveOpensAt: new Date(Date.now() - 48 * 3_600_000),
      reserveDeadline: new Date(Date.now() - 24 * 3_600_000),
    });
    // رزرو مستقیم (مهلت رزرو گذشته است)
    await db.insert(reservations).values({
      code: `R-${randomHex(4).toUpperCase()}`,
      accountId: student.accountId,
      offeringId: offering.id,
      serviceDate: offering.serviceDate,
      mealSlotId: offering.mealSlotId,
      cafeteriaId: offering.cafeteriaId,
      priceAtBooking: 100_000,
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

    const { markNoShows } = await import('../../src/services/reservation.service.js');
    const { createSilentLogger } = await import('../../src/lib/logger.js');
    const count = await markNoShows({ db, env: ctx.env, log: createSilentLogger() });
    expect(count).toBe(1);

    const [row] = await query<{ status: string }>(db, `SELECT status FROM reservations`);
    expect(row?.status).toBe('NoShow');
    const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
      student.accountId,
    ]);
    // رزرو به‌صورت مستقیم (بدون کسر وجه) درج شده بود ⇒ موجودی بدون تغییر و بدون بازگشت وجه
    expect(Number(account?.balance_rial)).toBe(500_000);
    const refunds = await query<{ n: number }>(
      db,
      `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type IN ('CancellationRefund','MealUnavailableRefund')`,
    );
    expect(refunds[0]?.n).toBe(0);
    await assertLedgerInvariants();
  });

  it('ویرایش تنظیمات با اعتبارسنجی بازه و ممیزی قبل/بعد', async () => {
    const admin = await createStaff(db, { role: 'SuperAdmin' });
    const client = await loginStaff(ctx.app, admin.username, admin.password);

    const invalid = await client.put('/api/v1/settings', { values: { cancel_cutoff_hours: '9999' } });
    expect(invalid.status).toBe(400);

    const valid = await client.put('/api/v1/settings', { values: { cancel_cutoff_hours: '24', helpText: 'راهنمای تست' } });
    expect(valid.status).toBe(200);
    const values = (valid.body as { values: Record<string, string> }).values;
    expect(values.cancel_cutoff_hours).toBe('24');
    expect(values.helpText).toBe('راهنمای تست');

    const audit = await query<{ details: unknown }>(
      db,
      `SELECT details FROM audit_logs WHERE action = 'settings.update' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(JSON.stringify(audit[0]?.details)).toContain('cancel_cutoff_hours');

    // ساعت وعده‌ها هم از همین صفحه قابل ویرایش است
    const slots = await query<{ id: string }>(db, `SELECT id FROM meal_slots WHERE code = 'Lunch'`);
    const slotUpdate = await client.put('/api/v1/settings', {
      mealSlots: [{ id: slots[0]!.id, title: 'ناهار', startTime: '12:30', endTime: '15:00', isActive: true }],
    });
    expect(slotUpdate.status).toBe(200);
    const [slot] = await query<{ start_time: string }>(db, `SELECT start_time::text FROM meal_slots WHERE code = 'Lunch'`);
    expect(slot?.start_time).toBe('12:30:00');
  });
});

describe('حذف نرم و یکپارچگی داده', () => {
  it('هیچ رکورد مالی/دانشجو/رزرو به‌صورت فیزیکی حذف نمی‌شود', async () => {
    const before = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    const student = await createStudent(db);
    await db
      .update(accounts)
      .set({ isActive: false })
      .where(sql`${accounts.id} = ${student.accountId}`);
    const after = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n) + 1);
    expect(ledgerEntries).toBeTruthy();
    expect(ledgerTransactions).toBeTruthy();
  });
});
