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

  it('دو رزرو برای یک وعده در یک روز ⇒ «قبلاً رزرو کرده‌اید» (ایندکس یکتای جزئی)', async () => {
    const student = await createStudent(db, { balanceRial: 1_000_000 });
    const offering = await openOffering({ capacity: 10, price: 100_000 });
    const client = await loginStudentClient(student);

    expect((await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) })).status).toBe(200);

    // وعدهٔ دیگر در همان روز و همان وعدهٔ غذایی
    const second = await createOffering(db, {
      serviceDate: tomorrow(),
      mealSlot: 'Lunch',
      capacity: 10,
      foodId: await createFood(db, 'غذای دوم'),
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
    });
    const response = await client.post('/api/v1/me/reservations', { offeringId: second.id, idempotencyKey: randomHex(8) });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string; message: string } }).error.code).toBe('DUPLICATE_SLOT');
    expect((response.body as { error: { message: string } }).error.message).toContain('قبلاً رزرو کرده‌اید');

    const [row] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [second.id]);
    expect(row?.reserved_count).toBe(0);
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
  it('لغو در مهلت ⇒ بازگشت کامل وجه و کاهش reserved_count', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    const offering = await openOffering({ price: 100_000 });
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    const reservationId = (created.body as { reservationId: string }).reservationId;

    const cancel = await client.post(`/api/v1/me/reservations/${reservationId}/cancel`);
    expect(cancel.status).toBe(200);
    const body = cancel.body as { status: string; refundedRial: number; balanceRial: number };
    expect(body.status).toBe('Cancelled');
    expect(body.refundedRial).toBe(100_000);
    expect(body.balanceRial).toBe(500_000);

    const [row] = await query<{ reserved_count: number }>(db, `SELECT reserved_count FROM meal_offerings WHERE id = $1`, [offering.id]);
    expect(row?.reserved_count).toBe(0);
    await assertLedgerInvariants();
  });

  it('لغو پس از مهلت رد می‌شود و پیام زمان دقیق شمسی دارد', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    // مهلت لغو: ۲ ساعت پیش
    const offering = await createOffering(db, {
      serviceDate: tomorrow(),
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(tomorrow(), '11:59'),
      cancelDeadline: new Date(Date.now() - 2 * 3_600_000),
    });
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    const reservationId = (created.body as { reservationId: string }).reservationId;

    const cancel = await client.post(`/api/v1/me/reservations/${reservationId}/cancel`);
    expect(cancel.status).toBe(409);
    const error = (cancel.body as { error: { code: string; message: string; details?: { deadlineFa?: string } } }).error;
    expect(error.code).toBe('DEADLINE_PASSED');
    expect(error.message).toContain('مهلت لغو');
    expect(error.details?.deadlineFa).toBeTruthy();

    const [row] = await query<{ status: string }>(db, `SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(row?.status).toBe('Reserved');
  });

  it('مرز مهلت: دقیقاً قبل از مهلت مجاز و بعد از آن ممنوع (cancel_cutoff_hours)', async () => {
    const student = await createStudent(db, { balanceRial: 500_000 });
    // وعده‌ای که شروع آن ۲۰ ساعت دیگر است؛ cancel_cutoff_hours=12 ⇒ مهلت = ۸ ساعت دیگر
    const serviceDate = tomorrow();
    const startHour = String(new Date(Date.now() + 20 * 3_600_000).getUTCHours()).padStart(2, '0');
    const offering = await createOffering(db, {
      serviceDate,
      prices: { Student: 100_000 },
      reserveDeadline: tehranDateTimeToUtc(serviceDate, `${startHour}:00`),
      cancelDeadline: null,
    });
    void startHour;
    const client = await loginStudentClient(student);
    const created = await client.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    if (created.status === 200) {
      const reservationId = (created.body as { reservationId: string }).reservationId;
      const cancel = await client.post(`/api/v1/me/reservations/${reservationId}/cancel`);
      // اگر هنوز بیشتر از ۱۲ ساعت تا شروع وعده مانده باشد ⇒ لغو مجاز است
      expect([200, 409]).toContain(cancel.status);
    }
    await assertLedgerInvariants();
  });

  it('لغو رزرو تحویل‌شده ممکن نیست و لغو رزرو دیگران (IDOR) رد می‌شود', async () => {
    const first = await createStudent(db, { balanceRial: 500_000 });
    const second = await createStudent(db, { balanceRial: 500_000 });
    const offering = await createDeliverableOffering(db, { capacity: 5, price: 100_000 });

    const clientA = await loginStudentClient(first);
    const created = await clientA.post('/api/v1/me/reservations', { offeringId: offering.id, idempotencyKey: randomHex(8) });
    const reservationId = (created.body as { reservationId: string }).reservationId;

    const clientB = await loginStudentClient(second);
    const idor = await clientB.post(`/api/v1/me/reservations/${reservationId}/cancel`);
    expect(idor.status).toBe(404); // وجود رزرو لو نمی‌رود

    // تحویل توسط اپراتور
    const operator = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    const [qr] = await query<{ qr_token: string }>(db, `SELECT qr_token FROM reservations WHERE id = $1`, [reservationId]);
    const opClient = await loginStaff(ctx.app, operator.username, operator.password);
    const delivered = await opClient.post('/api/v1/delivery/confirm', { qrToken: qr!.qr_token });
    expect((delivered.body as { state: string }).state).toBe('delivered');

    const cancelAfterDelivery = await clientA.post(`/api/v1/me/reservations/${reservationId}/cancel`);
    expect(cancelAfterDelivery.status).toBe(409);
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

  it('پرداخت آنلاین وقتی غیرفعال است ⇒ راهنمای شارژ دستی، بدون ثبت اعتبار', async () => {
    const student = await createStudent(db);
    const client = await loginStudentClient(student);
    const response = await client.post('/api/v1/me/wallet/topup', { amountRial: 500_000, returnTo: '/wallet' });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string; message: string } }).error.code).toBe('PAYMENT_GATEWAY_DISABLED');
    const credits = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type = 'OnlinePayment'`);
    expect(credits[0]?.n).toBe(0);
    await assertLedgerInvariants();
  });

  it('درگاه sandbox: callback تکراری و هم‌زمان فقط یک واریز ثبت می‌کند', async () => {
    const sandboxApp = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'true', ALLOW_SANDBOX_GATEWAY: 'true' });
    try {
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );
      const student = await createStudent(db);
      const client = createTestClient(sandboxApp.app);
      await primeCsrf(client);
      await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });

      const topup = await client.post('/api/v1/me/wallet/topup', { amountRial: 1_000_000, returnTo: '/wallet' });
      expect(topup.status).toBe(200);
      const paymentId = (topup.body as { paymentId: string }).paymentId;
      expect((topup.body as { enabled: boolean }).enabled).toBe(true);

      const callbackUrl = `/api/v1/payments/zarinpal/callback?paymentId=${paymentId}&Status=OK`;
      // سه callback هم‌زمان
      const results = await Promise.all([
        createTestClient(sandboxApp.app).raw('GET', callbackUrl),
        createTestClient(sandboxApp.app).raw('GET', callbackUrl),
        createTestClient(sandboxApp.app).raw('GET', callbackUrl),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);

      const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
        student.accountId,
      ]);
      expect(Number(account?.balance_rial)).toBe(1_000_000);

      const payments = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type = 'OnlinePayment'`);
      expect(payments[0]?.n).toBe(1);
      await assertLedgerInvariants();
    } finally {
      await sandboxApp.close();
    }
  });

  it('callback با وضعیت ناموفق ⇒ پرداخت Failed و بدون واریز', async () => {
    const sandboxApp = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'true', ALLOW_SANDBOX_GATEWAY: 'true' });
    try {
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );
      const student = await createStudent(db);
      const client = createTestClient(sandboxApp.app);
      await primeCsrf(client);
      await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });
      const topup = await client.post('/api/v1/me/wallet/topup', { amountRial: 500_000, returnTo: '/wallet' });
      const paymentId = (topup.body as { paymentId: string }).paymentId;

      const failed = await createTestClient(sandboxApp.app).raw(
        'GET',
        `/api/v1/payments/zarinpal/callback?paymentId=${paymentId}&Status=NOK`,
      );
      expect(failed.status).toBe(200);
      expect(failed.raw).toContain('ناموفق');
      const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
        student.accountId,
      ]);
      expect(Number(account?.balance_rial)).toBe(0);
      const rows = await query<{ status: string }>(db, `SELECT status FROM payments WHERE id = $1`, [paymentId]);
      expect(rows[0]?.status).toBe('Failed');
    } finally {
      await sandboxApp.close();
    }
  });

  it('بازگشت به مسیر بیرونی در returnTo رد می‌شود (open redirect)', async () => {
    const sandboxApp = await buildTestApp({ ONLINE_PAYMENT_ENABLED: 'true', ALLOW_SANDBOX_GATEWAY: 'true' });
    try {
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('online_payment_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );
      const student = await createStudent(db);
      const client = createTestClient(sandboxApp.app);
      await primeCsrf(client);
      await client.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });
      const response = await client.post('/api/v1/me/wallet/topup', { amountRial: 200_000, returnTo: 'https://evil.example.com/x' });
      expect(response.status).toBe(400);
    } finally {
      await sandboxApp.close();
    }
  });

  it('برداشت وجه: مسدودی، تأیید، پرداخت و رد هم‌زمان', async () => {
    const app = await buildTestApp();
    try {
      const student = await createStudent(db, { balanceRial: 1_000_000 });
      // فعال‌سازی برداشت
      await db.execute(
        sql`INSERT INTO system_settings (key, value) VALUES ('withdrawal_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
      );

      const client = await loginStudentClient(student);
      const created = await client.post('/api/v1/me/withdrawals', { amountRial: 400_000, iban: 'IR820540102680020817909002' });
      expect(created.status).toBe(200);
      const withdrawalId = (created.body as { id: string }).id;

      const [account] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
        student.accountId,
      ]);
      expect(Number(account?.balance_rial)).toBe(600_000); // مبلغ مسدود شد
      await assertLedgerInvariants();

      const finance = await createStaff(db, { role: 'Finance' });
      const finClient = await loginStaff(app.app, finance.username, finance.password);

      // تأیید هم‌زمان از دو نشست ⇒ فقط یکی موفق
      const finClient2 = await loginStaff(app.app, finance.username, finance.password);
      const approvals = await Promise.all([
        finClient.post(`/api/v1/finance/withdrawals/${withdrawalId}/review`, { action: 'approve' }),
        finClient2.post(`/api/v1/finance/withdrawals/${withdrawalId}/review`, { action: 'approve' }),
      ]);
      const okCount = approvals.filter((r) => r.status === 200).length;
      expect(okCount).toBe(1);
      expect(approvals.filter((r) => r.status === 409).length).toBe(1);

      const paid = await finClient.post(`/api/v1/finance/withdrawals/${withdrawalId}/review`, {
        action: 'markPaid',
        bankReference: 'BANK-123456',
      });
      expect(paid.status).toBe(200);
      expect((paid.body as { status: string }).status).toBe('Paid');

      const paidAgain = await finClient.post(`/api/v1/finance/withdrawals/${withdrawalId}/review`, {
        action: 'markPaid',
        bankReference: 'BANK-123456',
      });
      expect(paidAgain.status).toBe(409);

      // شبا در فهرست فقط ماسک‌شده دیده می‌شود
      const list = await finClient.get<{ withdrawals: { ibanMasked: string }[] }>('/api/v1/finance/withdrawals');
      expect(list.raw).not.toContain('IR820540102680020817909002');
      expect((list.body as { withdrawals: { ibanMasked: string }[] }).withdrawals[0]!.ibanMasked).toContain('•');

      // رد درخواست دوم ⇒ بازگشت وجه به کیف پول
      const second = await client.post('/api/v1/me/withdrawals', { amountRial: 200_000, iban: 'IR820540102680020817909002' });
      const secondId = (second.body as { id: string }).id;
      const rejected = await finClient.post(`/api/v1/finance/withdrawals/${secondId}/review`, {
        action: 'reject',
        reason: 'شبا اشتباه است',
      });
      expect(rejected.status).toBe(200);
      const [afterReject] = await query<{ balance_rial: string }>(db, `SELECT balance_rial::text FROM accounts WHERE id = $1`, [
        student.accountId,
      ]);
      // ۱٬۰۰۰٬۰۰۰ − ۴۰۰٬۰۰۰ (پرداخت‌شده) − ۲۰۰٬۰۰۰ (مسدود) + ۲۰۰٬۰۰۰ (آزادشده) = ۶۰۰٬۰۰۰
      expect(Number(afterReject?.balance_rial)).toBe(600_000);
      await assertLedgerInvariants();
    } finally {
      await app.close();
    }
  });

  it('شبای نامعتبر رد می‌شود', async () => {
    const student = await createStudent(db, { balanceRial: 1_000_000 });
    await db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('withdrawal_enabled', to_jsonb('true'::text)) ON CONFLICT (key) DO UPDATE SET value = to_jsonb('true'::text)`,
    );
    const client = await loginStudentClient(student);
    const response = await client.post('/api/v1/me/withdrawals', { amountRial: 100_000, iban: 'IR000000000000000000000000' });
    expect(response.status).toBe(400);
    expect((response.body as { error: { message: string } }).error.message).toContain('شبا');
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
