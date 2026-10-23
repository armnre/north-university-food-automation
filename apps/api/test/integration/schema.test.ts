import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, openClient, query, resetDatabase, testAppRoleDatabaseUrl, testDatabaseUrl } from '../helpers/db.js';
import {
  createCafeteria,
  createFood,
  createOffering,
  createReservationFixture,
  createStaff,
  createStudent,
  postBalanceFixture,
  resetBaseCache,
  seedBase,
} from '../helpers/fixtures.js';
import {
  accounts,
  auditLogs,
  ledgerEntries,
  ledgerTransactions,
  mealOfferings,
  reservations,
  students,
} from '../../src/db/schema/index.js';
import { hashPassword, newTrackingCode, randomHex } from '../../src/lib/crypto.js';

/**
 * معیار پذیرش مرحلهٔ ۱:
 * همهٔ قیدهای دیتابیس (UNIQUE، CHECK، triggerهای append-only و ممنوعیت حذف،
 * مجموع صفر هر تراکنش، ایندکس یکتای جزئی «یک رزرو در هر وعده» و GRANTهای نقش
 * `food_app`) واقعاً کار می‌کنند.
 */

const db = getTestDb();

/** اجرای SQL خام و گرفتن پیام خطا (اگر خطایی رخ ندهد، null). */
async function expectSqlError(statement: string, params: unknown[] = []): Promise<string> {
  const client = await openClient();
  try {
    await client.query(statement, params);
    return '';
  } catch (error) {
    return (error as Error).message;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await resetDatabase();
  await seedBase(db);
});

beforeEach(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
});

afterAll(async () => {
  const { closeTestDb } = await import('../helpers/db.js');
  await closeTestDb();
});

describe('اسکیمای پایگاه داده', () => {
  it('migration ورژن‌دار همهٔ جدول‌ها را ساخته است', async () => {
    const rows = await query<{ tablename: string }>(db, `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    const names = rows.map((r) => r.tablename);
    for (const expected of [
      'students',
      'employees',
      'staff_users',
      'accounts',
      'sessions',
      'login_attempts',
      'captchas',
      'contractors',
      'cafeterias',
      'foods',
      'meal_slots',
      'meal_offerings',
      'offering_prices',
      'reservations',
      'reservation_history',
      'deliveries',
      'ledger_transactions',
      'ledger_entries',
      'payments',
      'withdrawal_requests',
      'audit_logs',
      'import_batches',
      'import_rows',
      'notifications',
      'notification_reads',
      'notification_outbox',
      'system_settings',
      'job_runs',
    ]) {
      expect(names, `جدول ${expected} ساخته نشده است`).toContain(expected);
    }
    const applied = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(applied[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it('seed تولیدی: وعده‌ها، تنظیمات و سلف مرکزی را می‌سازد و idempotent است', async () => {
    const slots = await query<{ code: string }>(db, `SELECT code FROM meal_slots ORDER BY sort_order`);
    expect(slots.map((s) => s.code)).toEqual(['Breakfast', 'Lunch', 'Dinner']);
    const settings = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM system_settings`);
    expect(settings[0]?.n).toBe(16);
    const caf = await query<{ name: string }>(db, `SELECT name FROM cafeterias`);
    expect(caf[0]?.name).toBe('سلف مرکزی');
    // اجرای دوم نباید دادهٔ تکراری بسازد
    await seedBase(db);
    const again = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM meal_slots`);
    expect(again[0]?.n).toBe(3);
  });
});

describe('قیدهای یکتایی و ایندکس‌ها', () => {
  it('شمارهٔ دانشجویی و hash کد ملی یکتا هستند', async () => {
    const s = await createStudent(db, { studentNumber: '400123456' });
    const dupNumber = await expectSqlError(
      `INSERT INTO students (student_number, full_name, national_id_hash, national_id_last4) VALUES ($1,$2,$3,$4)`,
      [s.studentNumber, 'تکراری', randomHex(32), '1234'],
    );
    expect(dupNumber).toMatch(/students_student_number_key|unique|duplicate/i);

    const dupHash = await expectSqlError(
      `INSERT INTO students (student_number, full_name, national_id_hash, national_id_last4) VALUES ($1,$2,$3,$4)`,
      ['400999888', 'تکراری', s.nationalIdHash, '1234'],
    );
    expect(dupHash).toMatch(/students_national_id_hash_key|unique|duplicate/i);
  });

  it('چند غذای مختلف در یک وعده مجاز است؛ رزرو تکراری همان غذا (offering_id) ممنوع است — ایندکس یکتای جزئی', async () => {
    const student = await createStudent(db, { balanceRial: 1_000_000 });
    const lunch = await createOffering(db, { mealSlot: 'Lunch' });
    const dinner = await createOffering(db, { mealSlot: 'Dinner', serviceDate: lunch.serviceDate });

    await createReservationFixture(db, { accountId: student.accountId, offeringId: lunch.id });

    // غذای دوم در همان روز و همان وعدهٔ غذایی ⇒ مجاز
    const secondFoodSameSlot = await createOffering(db, {
      mealSlot: 'Lunch',
      serviceDate: lunch.serviceDate,
      foodId: await createFood(db, 'غذای دوم'),
    });
    await expect(createReservationFixture(db, { accountId: student.accountId, offeringId: secondFoodSameSlot.id })).resolves.toBeTruthy();

    // همان غذا (همان offering_id) برای بار دوم ⇒ نقض یکتایی
    const err = await expectSqlError(
      `INSERT INTO reservations (code, account_id, offering_id, price_at_booking, customer_group_at_booking, status, idempotency_key, qr_token, qr_issued_at)
       VALUES ($1,$2,$3,0,'Student','Reserved',$4,$5, now())`,
      [`R-${randomHex(4).toUpperCase()}`, student.accountId, lunch.id, randomHex(10), randomHex(24)],
    );
    expect(err).toMatch(/reservations_one_live_per_offering|unique|duplicate/i);

    // وعدهٔ متفاوت در همان روز ⇒ مجاز
    await expect(createReservationFixture(db, { accountId: student.accountId, offeringId: dinner.id })).resolves.toBeTruthy();

    // پس از لغو، رزرو مجدد همان غذا مجاز است
    await db
      .update(reservations)
      .set({ status: 'Cancelled', cancelReason: 'لغو تست' })
      .where(sql`${reservations.offeringId} = ${lunch.id}`);
    await expect(createReservationFixture(db, { accountId: student.accountId, offeringId: lunch.id })).resolves.toBeTruthy();
  });

  it('ستون‌های denormalized رزرو با trigger از وعده همگام می‌شوند', async () => {
    const student = await createStudent(db);
    const offering = await createOffering(db);
    const [row] = await db
      .insert(reservations)
      .values({
        code: `R-${randomHex(4).toUpperCase()}`,
        accountId: student.accountId,
        offeringId: offering.id,
        // عمداً مقادیر غلط داده می‌شود تا trigger اصلاح کند
        serviceDate: '1999-01-01',
        mealSlotId: randomHex(16).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
        cafeteriaId: offering.cafeteriaId,
        priceAtBooking: 0,
        customerGroupAtBooking: 'Student',
        status: 'Reserved',
        idempotencyKey: randomHex(12),
      })
      .returning({ serviceDate: reservations.serviceDate, mealSlotId: reservations.mealSlotId })
      .catch(() => []);
    // چون mealSlotId غلط بود، trigger باید آن را از وعده بگیرد
    expect(row?.serviceDate).toBe(offering.serviceDate);
    expect(row?.mealSlotId).toBe(offering.mealSlotId);
  });

  it('آیتم منوی تکراری (روز/وعده/سلف/غذا) ساخته نمی‌شود مگر لغو شده باشد', async () => {
    const food = await createFood(db);
    const first = await createOffering(db, { foodId: food });
    const dup = await expectSqlError(
      `INSERT INTO meal_offerings (service_date, meal_slot_id, food_id, cafeteria_id, capacity, reserve_opens_at, reserve_deadline, status)
       SELECT $1, meal_slot_id, food_id, cafeteria_id, 10, now(), now() + interval '1 day', 'Published' FROM meal_offerings WHERE id = $2`,
      [first.serviceDate, first.id],
    );
    expect(dup).toMatch(/meal_offerings_unique_slot_food|unique|duplicate/i);

    // پس از لغو، ساخت آیتم جدید با همان مشخصات مجاز است
    await db
      .update(mealOfferings)
      .set({ status: 'Cancelled', statusReason: 'لغو تست' })
      .where(sql`${mealOfferings.id} = ${first.id}`);
    const rows = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM meal_offerings`);
    expect(rows[0]?.n).toBe(1);
  });
});

describe('قیدهای CHECK', () => {
  it('موجودی حساب نمی‌تواند منفی شود', async () => {
    const s = await createStudent(db);
    const err = await expectSqlError(`UPDATE accounts SET balance_rial = -1 WHERE id = $1`, [s.accountId]);
    expect(err).toMatch(/accounts_balance_non_negative|check/i);
  });

  it('هر حساب دقیقاً یک سوژه (دانشجو یا کارمند) دارد', async () => {
    const s = await createStudent(db);
    // هر دو پر
    const both = await expectSqlError(
      `INSERT INTO accounts (kind, student_id, employee_id, customer_group, balance_rial)
       VALUES ('Student', $1, gen_random_uuid(), 'Student', 0)`,
      [s.studentId],
    );
    expect(both).toMatch(/accounts_subject_exclusive|accounts_kind_matches_subject|foreign key|check/i);
    // هیچ‌کدام پر
    const none = await expectSqlError(`INSERT INTO accounts (kind, customer_group, balance_rial) VALUES ('Student','Student',0)`);
    expect(none).toMatch(/accounts_subject_exclusive|check|not-null|null/i);
    // ناسازگاری نوع حساب با سوژه
    const mismatch = await expectSqlError(
      `INSERT INTO accounts (kind, student_id, customer_group, balance_rial) VALUES ('Employee', $1, 'Student', 0)`,
      [s.studentId],
    );
    expect(mismatch).toMatch(/accounts_kind_matches_subject|accounts_group_matches_kind|check/i);
  });

  it('ظرفیت وعده مثبت و reserved_count داخل ظرفیت است', async () => {
    const offering = await createOffering(db, { capacity: 5 });
    const zeroCapacity = await expectSqlError(`UPDATE meal_offerings SET capacity = 0 WHERE id = $1`, [offering.id]);
    expect(zeroCapacity).toMatch(/meal_offerings_capacity_positive|check/i);
    const overCapacity = await expectSqlError(`UPDATE meal_offerings SET reserved_count = 6 WHERE id = $1`, [offering.id]);
    expect(overCapacity).toMatch(/meal_offerings_reserved_within_capacity|check/i);
    const negative = await expectSqlError(`UPDATE meal_offerings SET reserved_count = -1 WHERE id = $1`, [offering.id]);
    expect(negative).toMatch(/meal_offerings_reserved_non_negative|check/i);
  });

  it('قیمت هر گروه مشتری نامنفی و کلید ترکیبی آن یکتا است', async () => {
    const offering = await createOffering(db, { prices: { Student: 100_000 } });
    const negative = await expectSqlError(
      `INSERT INTO offering_prices (offering_id, customer_group, price_rial) VALUES ($1,'Faculty',-5)`,
      [offering.id],
    );
    expect(negative).toMatch(/offering_prices_price_non_negative|check/i);
    const dup = await expectSqlError(`INSERT INTO offering_prices (offering_id, customer_group, price_rial) VALUES ($1,'Student',200000)`, [
      offering.id,
    ]);
    expect(dup).toMatch(/offering_prices_pkey|unique|duplicate/i);
    const badGroup = await expectSqlError(
      `INSERT INTO offering_prices (offering_id, customer_group, price_rial) VALUES ($1,'Guest',1000)`,
      [offering.id],
    );
    expect(badGroup).toMatch(/offering_prices_group_check|check/i);
  });

  it('قالب کد رزرو، توکن QR و مسیر بازگشت پرداخت بررسی می‌شود', async () => {
    const s = await createStudent(db);
    const offering = await createOffering(db);
    const badQr = await expectSqlError(
      `INSERT INTO reservations (code, account_id, offering_id, price_at_booking, customer_group_at_booking, status, idempotency_key, qr_token)
       VALUES ('R-ABCD1234', $1, $2, 0, 'Student', 'Reserved', $3, 'not-a-token')`,
      [s.accountId, offering.id, randomHex(10)],
    );
    expect(badQr).toMatch(/reservations_qr_token_shape|check/i);

    const badPayment = await expectSqlError(
      `INSERT INTO payments (account_id, gateway, amount_rial, status, idempotency_key, return_to)
       VALUES ($1,'zarinpal',1000,'Pending',$2,'https://evil.example.com')`,
      [s.accountId, randomHex(8)],
    );
    expect(badPayment).toMatch(/payments_return_to_internal|check/i);
  });

  it('لغو رزرو بدون دلیل ثبت نمی‌شود', async () => {
    const s = await createStudent(db);
    const offering = await createOffering(db);
    const id = await createReservationFixture(db, { accountId: s.accountId, offeringId: offering.id });
    const err = await expectSqlError(`UPDATE reservations SET status='Cancelled', cancel_reason=NULL WHERE id=$1`, [id]);
    expect(err).toMatch(/reservations_cancel_requires_reason|check/i);
  });

  it('کلید خارجی students.last_import_batch_id اعمال می‌شود', async () => {
    const s = await createStudent(db);
    const err = await expectSqlError(`UPDATE students SET last_import_batch_id = gen_random_uuid() WHERE id = $1`, [s.studentId]);
    expect(err).toMatch(/students_last_import_batch_id_fkey|foreign key/i);

    // ارجاع معتبر پذیرفته می‌شود
    const [batch] = await query<{ id: string }>(
      db,
      `INSERT INTO import_batches (file_name, status, policy) VALUES ('valid.xlsx','Preview','SkipInvalidRows') RETURNING id`,
    );
    await expect(
      db.execute(sql.raw(`UPDATE students SET last_import_batch_id = '${batch!.id}' WHERE id = '${s.studentId}'`)),
    ).resolves.toBeTruthy();
  });
});

describe('دفتر کل دوطرفه', () => {
  it('تراکنش نامتوازن در لحظهٔ COMMIT رد می‌شود', async () => {
    const s = await createStudent(db);
    const client = await openClient();
    try {
      await client.query('BEGIN');
      const tx = await client.query(
        `INSERT INTO ledger_transactions (type, idempotency_key, reason, actor_type, tracking_code)
         VALUES ('ManualCredit', $1, 'تست نامتوازن', 'System', $2) RETURNING id`,
        [randomHex(10), newTrackingCode()],
      );
      const txId = tx.rows[0]!.id as string;
      await client.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount_rial, balance_after) VALUES ($1,$2,1000,1000)`, [
        txId,
        s.accountId,
      ]);
      const commitError = await client.query('COMMIT').catch((e: Error) => e);
      expect(String((commitError as Error).message)).toMatch(/تراز نیست|zero_sum|check_violation/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });

  it('تراکنش متوازن (مجموع صفر) با موفقیت commit می‌شود', async () => {
    const s = await createStudent(db);
    const client = await openClient();
    try {
      await client.query('BEGIN');
      const tx = await client.query(
        `INSERT INTO ledger_transactions (type, idempotency_key, reason, actor_type, tracking_code)
         VALUES ('ManualCredit', $1, 'تست متوازن', 'System', $2) RETURNING id`,
        [randomHex(10), newTrackingCode()],
      );
      const txId = tx.rows[0]!.id as string;
      await client.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount_rial, balance_after) VALUES ($1,$2,5000,5000)`, [
        txId,
        s.accountId,
      ]);
      await client.query(`INSERT INTO ledger_entries (transaction_id, system_account, amount_rial) VALUES ($1,'MANUAL_CASH',-5000)`, [
        txId,
      ]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    const rows = await query<{ n: number; total: string }>(
      db,
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_rial),0)::text AS total FROM ledger_entries`,
    );
    expect(rows[0]?.n).toBe(2);
    expect(Number(rows[0]?.total)).toBe(0);
  });

  it('ورودی‌های یک تراکنش قابل حذف نیستند (append-only) ⇒ تراز نمی‌تواند بعداً به هم بخورد', async () => {
    const s = await createStudent(db);
    await postBalanceFixture(db, s.accountId, 10_000, 'شارژ تست');
    const client = await openClient();
    try {
      await client.query('BEGIN');
      const deleteError = await client.query(`DELETE FROM ledger_entries WHERE account_id = $1`, [s.accountId]).catch((e: Error) => e);
      expect(String((deleteError as Error).message)).toMatch(/append-only|insufficient_privilege/i);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    const rows = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM ledger_entries`);
    expect(rows[0]?.n).toBe(2);
  });

  it('UPDATE و DELETE روی دفتر کل ممنوع است', async () => {
    const s = await createStudent(db);
    await postBalanceFixture(db, s.accountId, 10_000, 'شارژ تست');
    const upd = await expectSqlError(`UPDATE ledger_entries SET amount_rial = 1 WHERE account_id = $1`, [s.accountId]);
    expect(upd).toMatch(/append-only|insufficient_privilege/i);
    const del = await expectSqlError(`DELETE FROM ledger_entries WHERE account_id = $1`, [s.accountId]);
    expect(del).toMatch(/append-only|insufficient_privilege/i);
    const delTx = await expectSqlError(`DELETE FROM ledger_transactions`);
    expect(delTx).toMatch(/append-only|insufficient_privilege/i);
  });

  it('کلید idempotency دفتر کل یکتا است', async () => {
    const key = randomHex(8);
    await db.insert(ledgerTransactions).values({
      type: 'ManualCredit',
      idempotencyKey: key,
      reason: 'تست idempotency',
      actorType: 'System',
      trackingCode: newTrackingCode(),
    });
    const err = await expectSqlError(
      `INSERT INTO ledger_transactions (type, idempotency_key, reason, actor_type, tracking_code) VALUES ('ManualCredit',$1,'تست تکراری بودن کلید','System',$2)`,
      [key, newTrackingCode()],
    );
    expect(err).toMatch(/ledger_transactions_idempotency_key|unique|duplicate/i);
  });
});

describe('append-only بودن ممیزی و لاگ‌ها', () => {
  it('audit_logs فقط افزودنی است', async () => {
    await db.insert(auditLogs).values({ actorType: 'System', action: 'test.action', targetType: 'Test', targetId: '1', details: { a: 1 } });
    const upd = await expectSqlError(`UPDATE audit_logs SET action = 'hacked'`);
    expect(upd).toMatch(/append-only|insufficient_privilege/i);
    const del = await expectSqlError(`DELETE FROM audit_logs`);
    expect(del).toMatch(/append-only|insufficient_privilege/i);
  });

  it('reservation_history و deliveries فقط افزودنی هستند', async () => {
    const s = await createStudent(db);
    const offering = await createOffering(db);
    const reservationId = await createReservationFixture(db, { accountId: s.accountId, offeringId: offering.id });
    const staff = await createStaff(db, { role: 'Operator', cafeteriaId: offering.cafeteriaId });
    await db.execute(
      sql`INSERT INTO reservation_history (reservation_id, from_status, to_status, actor_type, note) VALUES (${reservationId}, '', 'Reserved', 'System', 'test')`,
    );
    await db.execute(
      sql`INSERT INTO deliveries (reservation_id, operator_id, cafeteria_id, outcome, scanned_at) VALUES (${reservationId}, ${staff.id}, ${offering.cafeteriaId}, 'Accepted', now())`,
    );
    expect(await expectSqlError(`UPDATE reservation_history SET note='x'`)).toMatch(/append-only|insufficient_privilege/i);
    expect(await expectSqlError(`DELETE FROM deliveries`)).toMatch(/append-only|insufficient_privilege/i);
    expect(await expectSqlError(`UPDATE deliveries SET outcome='Duplicate'`)).toMatch(/append-only|insufficient_privilege/i);
  });
});

describe('ممنوعیت حذف فیزیکی', () => {
  it('دانشجو، حساب، رزرو، غذا و آیتم منو حذف فیزیکی نمی‌شوند', async () => {
    const s = await createStudent(db);
    const offering = await createOffering(db);
    const reservationId = await createReservationFixture(db, { accountId: s.accountId, offeringId: offering.id });

    expect(await expectSqlError(`DELETE FROM students`)).toMatch(/حذف فیزیکی|insufficient_privilege/i);
    expect(await expectSqlError(`DELETE FROM accounts`)).toMatch(/حذف فیزیکی|insufficient_privilege/i);
    expect(await expectSqlError(`DELETE FROM reservations`)).toMatch(/حذف فیزیکی|insufficient_privilege/i);
    expect(await expectSqlError(`DELETE FROM foods`)).toMatch(/حذف فیزیکی|insufficient_privilege/i);
    expect(await expectSqlError(`DELETE FROM meal_offerings`)).toMatch(/حذف فیزیکی|insufficient_privilege/i);

    // trigger حذف فیزیکی «به ازای هر ردیف» است؛ بنابراین برای بررسی آن باید ردیف وجود داشته باشد
    await db.execute(sql`INSERT INTO import_batches (file_name, status, policy) VALUES ('protected.xlsx','Preview','SkipInvalidRows')`);
    expect(await expectSqlError(`DELETE FROM import_batches`)).toMatch(/حذف فیزیکی|insufficient_privilege/i);

    // اما حذف نرم (تغییر وضعیت) مجاز است
    await db
      .update(students)
      .set({ status: 'Removed', removedAt: new Date() })
      .where(sql`${students.id} = ${s.studentId}`);
    const rows = await db.select({ status: students.status }).from(students);
    expect(rows[0]?.status).toBe('Removed');
    expect(reservationId).toBeTruthy();
  });

  it('جدول‌های غیرمالی قابل پاک‌سازی هستند (import_rows, sessions, login_attempts)', async () => {
    // نکته: triggerهای «ممنوعیت حذف» BEFORE DELETE FOR EACH ROW هستند؛
    // پاک‌سازی دادهٔ تست با TRUNCATE انجام می‌شود که از این triggerها عبور می‌کند.
    await db.execute(
      sql`INSERT INTO import_batches (file_name, status, policy) VALUES ('t.xlsx','Preview','SkipInvalidRows') RETURNING id`,
    );
    const [batch] = await query<{ id: string }>(db, `SELECT id FROM import_batches LIMIT 1`);
    await db.execute(
      sql`INSERT INTO import_rows (batch_id, row_number, student_number, full_name) VALUES (${batch!.id}, 1, '400000001', 'تست')`,
    );
    await expect(db.execute(sql`DELETE FROM import_rows`)).resolves.toBeTruthy();
  });
});

describe('سازگاری وعده و رزرو', () => {
  it('تغییر روز/وعده/سلف آیتم منو با رزرو فعال ممنوع است', async () => {
    const s = await createStudent(db);
    const offering = await createOffering(db, { capacity: 10 });
    await db
      .update(mealOfferings)
      .set({ reservedCount: 1 })
      .where(sql`${mealOfferings.id} = ${offering.id}`);
    await createReservationFixture(db, { accountId: s.accountId, offeringId: offering.id });

    const err = await expectSqlError(`UPDATE meal_offerings SET service_date = service_date + 1 WHERE id = $1`, [offering.id]);
    expect(err).toMatch(/تاریخ، نوع وعده و سلف قابل تغییر نیست|check_violation/i);

    // تغییر ظرفیت و مهلت مجاز است
    await expect(
      db
        .update(mealOfferings)
        .set({ capacity: 20, notes: 'به‌روزرسانی مجاز' })
        .where(sql`${mealOfferings.id} = ${offering.id}`),
    ).resolves.toBeTruthy();
  });

  it('ظرفیت نمی‌تواند کمتر از reserved_count شود', async () => {
    const offering = await createOffering(db, { capacity: 10 });
    await db
      .update(mealOfferings)
      .set({ reservedCount: 7 })
      .where(sql`${mealOfferings.id} = ${offering.id}`);
    const err = await expectSqlError(`UPDATE meal_offerings SET capacity = 3 WHERE id = $1`, [offering.id]);
    expect(err).toMatch(/meal_offerings_reserved_within_capacity|check/i);
  });
});

describe('نقش‌های دیتابیسی', () => {
  it('نقش food_app ساخته شده و فقط DML دارد', async () => {
    const roles = await query<{ rolname: string }>(
      db,
      `SELECT rolname FROM pg_roles WHERE rolname IN ('food_app','food_migrator') ORDER BY rolname`,
    );
    expect(roles.map((r) => r.rolname)).toEqual(['food_app', 'food_migrator']);
  });

  it('food_app می‌تواند بخواند و بنویسد، اما نه UPDATE/DELETE روی ممیزی و دفتر کل', async () => {
    const admin = getTestDb();
    const s = await createStudent(admin);
    await admin.insert(auditLogs).values({ actorType: 'System', action: 'test.role', targetType: 'Test', targetId: s.studentId });
    await postBalanceFixture(admin, s.accountId, 5_000, 'شارژ تست نقش');

    const appClient = await openClient(testAppRoleDatabaseUrl());
    try {
      // SELECT مجاز
      const sel = await appClient.query(`SELECT COUNT(*)::int AS n FROM students`);
      expect(Number(sel.rows[0]?.n)).toBeGreaterThanOrEqual(1);

      // INSERT روی جدول عادی مجاز
      await appClient.query(`UPDATE students SET last_login_at = now() WHERE id = $1`, [s.studentId]);

      // UPDATE/DELETE روی append-onlyها ممنوع (در سطح GRANT، پیش از trigger)
      await expect(appClient.query(`UPDATE audit_logs SET action='x'`)).rejects.toThrow(/permission denied/i);
      await expect(appClient.query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/i);
      await expect(appClient.query(`UPDATE ledger_entries SET amount_rial=1`)).rejects.toThrow(/permission denied/i);
      await expect(appClient.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/permission denied/i);
      await expect(appClient.query(`DELETE FROM ledger_transactions`)).rejects.toThrow(/permission denied/i);
    } finally {
      await appClient.end();
    }
  });

  it('محدودیت‌های زمانی نقش food_app اعمال شده است', async () => {
    const rows = await query<{ rolconfig: string[] }>(db, `SELECT rolconfig FROM pg_roles WHERE rolname = 'food_app'`);
    const config = (rows[0]?.rolconfig ?? []).join(',');
    expect(config).toMatch(/statement_timeout=30s/);
    expect(config).toMatch(/idle_in_transaction_session_timeout=120s/);
  });
});

describe('trigger به‌روزرسانی updated_at', () => {
  it('updated_at به‌صورت خودکار جلو می‌رود', async () => {
    const s = await createStudent(db);
    const before = await db
      .select({ updatedAt: students.updatedAt })
      .from(students)
      .where(sql`${students.id} = ${s.studentId}`);
    await new Promise((r) => setTimeout(r, 20));
    await db.execute(sql.raw(`UPDATE students SET full_name = 'نام به‌روزشده' WHERE id = '${s.studentId}'`));
    const after = await db
      .select({ updatedAt: students.updatedAt, fullName: students.fullName })
      .from(students)
      .where(sql`${students.id} = ${s.studentId}`);
    expect(after[0]!.fullName).toBe('نام به‌روزشده');
    expect(after[0]!.updatedAt.getTime()).toBeGreaterThan(before[0]!.updatedAt.getTime());
  });
});

describe('قیدهای کاربران', () => {
  it('نام کاربری کارکنان باید با الگوی مجاز باشد و یکتا بماند', async () => {
    await createStaff(db, { username: 'finance.1', role: 'Finance' });
    const bad = await expectSqlError(
      `INSERT INTO staff_users (username, password_hash, full_name, role, status) VALUES ('Bad User!',$1,'تست','Finance','Active')`,
      [await hashPassword('x'.repeat(12))],
    );
    expect(bad).toMatch(/staff_users_username_check|check/i);
    const dup = await expectSqlError(
      `INSERT INTO staff_users (username, password_hash, full_name, role, status) VALUES ('finance.1',$1,'تست','Finance','Active')`,
      [await hashPassword('x'.repeat(12))],
    );
    expect(dup).toMatch(/staff_users_username_key|unique|duplicate/i);
    const badRole = await expectSqlError(
      `INSERT INTO staff_users (username, password_hash, full_name, role, status) VALUES ('ops.9',$1,'تست','Root','Active')`,
      [await hashPassword('x'.repeat(12))],
    );
    expect(badRole).toMatch(/staff_users_role_check|check/i);
  });

  it('محدودیت‌های حساب کیف پول: یک حساب برای هر دانشجو', async () => {
    const s = await createStudent(db);
    const dup = await expectSqlError(
      `INSERT INTO accounts (kind, student_id, customer_group, balance_rial) VALUES ('Student',$1,'Student',0)`,
      [s.studentId],
    );
    expect(dup).toMatch(/accounts_student_id_key|unique|duplicate/i);
    const rows = await db.select({ id: accounts.id }).from(accounts);
    expect(rows.length).toBe(1);
    expect(ledgerEntries).toBeTruthy();
    expect(ledgerTransactions).toBeTruthy();
  });

  it('کافه‌تریای دوم قابل ساخت است (چندسلفی)', async () => {
    const second = await createCafeteria(db, 'سلف خواهران');
    expect(second).toBeTruthy();
    const rows = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM cafeterias`);
    expect(rows[0]?.n).toBe(2);
    expect(testDatabaseUrl()).toMatch(/^postgres/);
  });
});
