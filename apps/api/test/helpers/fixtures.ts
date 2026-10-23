import { sql } from 'drizzle-orm';
import { addDays, tehranDateTimeToUtc, tehranParts, tehranToday } from '@food/shared';
import type { Db } from '../../src/db/client.js';
import { seedProduction } from '../../src/db/seed.js';
import {
  accounts,
  cafeterias,
  contractors,
  employees,
  foods,
  ledgerEntries,
  ledgerTransactions,
  mealOfferings,
  mealSlots,
  offeringPrices,
  reservations,
  staffUsers,
  students,
} from '../../src/db/schema/index.js';
import { hashPassword, hmacSha256Hex, newReservationCode, newTrackingCode, randomHex } from '../../src/lib/crypto.js';

/**
 * دادهٔ پایهٔ تست‌ها.
 * همه‌چیز در PostgreSQL واقعی نوشته می‌شود (بدون mock) و قیدهای دیتابیس
 * (مجموع صفر دفتر کل، `balance_after`، CHECKها) در همین fixtureها هم رعایت می‌شود.
 */

export type BaseFixture = { cafeteriaId: string; slots: Record<string, string> };

/** seed تولیدی: وعده‌های پیش‌فرض، تنظیمات و سلف مرکزی. */
export async function seedBase(db: Db): Promise<BaseFixture> {
  await seedProduction(db);
  const slotRows = await db.select({ id: mealSlots.id, code: mealSlots.code }).from(mealSlots);
  const slots: Record<string, string> = {};
  for (const s of slotRows) slots[s.code] = s.id;
  const caf = await db.select({ id: cafeterias.id }).from(cafeterias).limit(1);
  baseCache = { cafeteriaId: caf[0]?.id ?? '', slots };
  return baseCache;
}

/** ساخت کد ملی معتبر (با رقم کنترلی صحیح) از یک عدد اولیه. */
export function makeNationalId(seed: number): string {
  const base = String(100_000_000 + (Math.abs(seed) % 899_999_999))
    .slice(0, 9)
    .padStart(9, '0');
  const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const rest = sum % 11;
  const check = rest < 2 ? rest : 11 - rest;
  return `${base}${check}`;
}

/** کد ملی معتبر که رقم کنترلی‌اش عمداً خراب شده (برای تست ورود ناموفق). */
export function makeInvalidNationalId(seed: number): string {
  const valid = makeNationalId(seed);
  const last = Number(valid[9] ?? '0');
  return `${valid.slice(0, 9)}${(last + 1) % 10}`;
}

export type StudentFixture = {
  studentId: string;
  accountId: string;
  studentNumber: string;
  nationalId: string;
  nationalIdHash: string;
};

export async function createStudent(
  db: Db,
  options: {
    studentNumber?: string;
    fullName?: string;
    nationalId?: string;
    faculty?: string;
    major?: string;
    status?: string;
    balanceRial?: number;
    pepper?: string;
  } = {},
): Promise<StudentFixture> {
  const nationalId = options.nationalId ?? makeNationalId(Math.floor(Math.random() * 800_000_000));
  const pepper = options.pepper ?? process.env.NATIONAL_ID_PEPPER ?? 'test-national-id-pepper-0123456789abcdef';
  const nationalIdHash = hmacSha256Hex(pepper, nationalId);
  const studentNumber = options.studentNumber ?? String(400_000_000 + Math.floor(Math.random() * 99_999_999));

  const [student] = await db
    .insert(students)
    .values({
      studentNumber,
      fullName: options.fullName ?? `دانشجوی آزمایشی ${studentNumber}`,
      faculty: options.faculty ?? 'فنی و مهندسی',
      major: options.major ?? 'مهندسی کامپیوتر',
      degree: 'کارشناسی',
      entryYear: 1402,
      nationalIdHash,
      nationalIdLast4: nationalId.slice(-4),
      status: options.status ?? 'Active',
    })
    .returning({ id: students.id });

  const [account] = await db
    .insert(accounts)
    .values({
      kind: 'Student',
      studentId: student!.id,
      customerGroup: 'Student',
      balanceRial: options.balanceRial ?? 0,
      isActive: true,
    })
    .returning({ id: accounts.id });

  if ((options.balanceRial ?? 0) > 0) {
    await postBalanceFixture(db, account!.id, options.balanceRial ?? 0, 'شارژ اولیهٔ تست');
  }

  return { studentId: student!.id, accountId: account!.id, studentNumber, nationalId, nationalIdHash };
}

export type EmployeeFixture = {
  employeeId: string;
  accountId: string;
  username: string;
  password: string;
  customerGroup: string;
};

export async function createEmployee(
  db: Db,
  options: {
    username?: string;
    password?: string;
    customerGroup?: 'Employee' | 'Faculty' | 'Contractor';
    balanceRial?: number;
    status?: string;
    mobile?: string;
    mustChangePassword?: boolean;
  } = {},
): Promise<EmployeeFixture> {
  const username = options.username ?? `emp${Math.floor(Math.random() * 999_999)}`;
  const password = options.password ?? 'employee-password-123';
  const customerGroup = options.customerGroup ?? 'Employee';

  const [employee] = await db
    .insert(employees)
    .values({
      username,
      passwordHash: await hashPassword(password),
      fullName: `کارمند ${username}`,
      customerGroup,
      department: 'اداری',
      mobile: options.mobile ?? null,
      mustChangePassword: options.mustChangePassword ?? false,
      status: options.status ?? 'Active',
    })
    .returning({ id: employees.id });

  const [account] = await db
    .insert(accounts)
    .values({
      kind: 'Employee',
      employeeId: employee!.id,
      customerGroup,
      balanceRial: options.balanceRial ?? 0,
      isActive: true,
    })
    .returning({ id: accounts.id });

  if ((options.balanceRial ?? 0) > 0) {
    await postBalanceFixture(db, account!.id, options.balanceRial ?? 0, 'شارژ اولیهٔ تست');
  }

  return { employeeId: employee!.id, accountId: account!.id, username, password, customerGroup };
}

export type StaffFixture = { id: string; username: string; password: string; role: string };

export async function createStaff(
  db: Db,
  options: {
    username?: string;
    password?: string;
    role: string;
    cafeteriaId?: string | null;
    contractorId?: string | null;
    status?: string;
    mustChangePassword?: boolean;
  },
): Promise<StaffFixture> {
  const username = options.username ?? `${options.role.toLowerCase()}.${Math.floor(Math.random() * 99_999)}`;
  const password = options.password ?? 'staff-password-123';
  const [row] = await db
    .insert(staffUsers)
    .values({
      username,
      passwordHash: await hashPassword(password),
      fullName: `کارمند ${options.role}`,
      role: options.role,
      status: options.status ?? 'Active',
      cafeteriaId: options.cafeteriaId ?? null,
      contractorId: options.contractorId ?? null,
      mustChangePassword: options.mustChangePassword ?? false,
    })
    .returning({ id: staffUsers.id });
  return { id: row!.id, username, password, role: options.role };
}

export async function createContractor(db: Db, name = 'پیمانکار نمونه'): Promise<string> {
  const [row] = await db
    .insert(contractors)
    .values({ name, contractNumber: 'C-1402-01', isActive: true })
    .returning({ id: contractors.id });
  return row!.id;
}

export async function createCafeteria(db: Db, name = 'سلف شماره ۲', contractorId?: string): Promise<string> {
  const [row] = await db
    .insert(cafeterias)
    .values({ name, location: 'پردیس مرکزی', contractorId: contractorId ?? null, isActive: true })
    .returning({ id: cafeterias.id });
  return row!.id;
}

export async function createFood(
  db: Db,
  name = 'چلوکباب',
  options: { defaultPriceRial?: number; category?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(foods)
    .values({
      name,
      description: 'غذای آزمایشی',
      category: options.category ?? 'غذای اصلی',
      calories: 700,
      defaultPriceRial: options.defaultPriceRial ?? 300_000,
      defaultCapacity: 100,
      isActive: true,
    })
    .returning({ id: foods.id });
  return row!.id;
}

export type OfferingFixture = { id: string; foodId: string; cafeteriaId: string; serviceDate: string; mealSlotId: string };

export async function createOffering(
  db: Db,
  options: {
    serviceDate?: string;
    mealSlot?: string;
    foodId?: string;
    cafeteriaId?: string;
    capacity?: number;
    reservedCount?: number;
    status?: string;
    prices?: Partial<Record<string, number>>;
    reserveOpensAt?: Date;
    reserveDeadline?: Date;
    cancelDeadline?: Date | null;
  } = {},
): Promise<OfferingFixture> {
  const base = await ensureBase(db);
  const serviceDate = options.serviceDate ?? addDays(tehranToday(), 1);
  const mealSlotCode = options.mealSlot ?? 'Lunch';
  const foodId = options.foodId ?? (await createFood(db, `غذای ${Math.floor(Math.random() * 999_999)}`));
  const cafeteriaId = options.cafeteriaId ?? base.cafeteriaId;
  const mealSlotId = base.slots[mealSlotCode];
  if (!mealSlotId) throw new Error('وعدهٔ پایه یافت نشد؛ ابتدا seedBase را اجرا کنید.');

  const slotRow = await db
    .select({ startTime: mealSlots.startTime })
    .from(mealSlots)
    .where(sql`${mealSlots.id} = ${mealSlotId}`)
    .limit(1);
  const startTime = String(slotRow[0]?.startTime ?? '12:00:00').slice(0, 5);

  const reserveDeadline = options.reserveDeadline ?? tehranDateTimeToUtc(serviceDate, startTime);
  const [row] = await db
    .insert(mealOfferings)
    .values({
      serviceDate,
      mealSlotId,
      foodId,
      cafeteriaId,
      capacity: options.capacity ?? 100,
      reservedCount: options.reservedCount ?? 0,
      reserveOpensAt: options.reserveOpensAt ?? new Date(Date.now() - 3_600_000),
      reserveDeadline,
      cancelDeadline: options.cancelDeadline ?? null,
      status: options.status ?? 'Published',
      notes: '',
      publishedAt: new Date(),
    })
    .returning({ id: mealOfferings.id });

  const prices = options.prices ?? { Student: 300_000 };
  for (const [group, price] of Object.entries(prices)) {
    if (price == null) continue;
    await db.insert(offeringPrices).values({ offeringId: row!.id, customerGroup: group, priceRial: price });
  }

  return { id: row!.id, foodId, cafeteriaId, serviceDate, mealSlotId };
}

/**
 * نوشتن یک تراکنش دوطرفهٔ تراز برای شارژ اولیهٔ حساب در تست.
 * از سرویس مالی عبور نمی‌کند (fixture ساده) اما قیدهای دیتابیس را رعایت می‌کند.
 */
export async function postBalanceFixture(db: Db, accountId: string, amountRial: number, reason: string): Promise<string> {
  const [tx] = await db
    .insert(ledgerTransactions)
    .values({
      type: amountRial >= 0 ? 'ManualCredit' : 'ManualDebit',
      idempotencyKey: `fixture:${accountId}:${randomHex(8)}`,
      referenceType: 'Manual',
      reason,
      actorType: 'System',
      trackingCode: newTrackingCode(),
    })
    .returning({ id: ledgerTransactions.id });

  const [current] = await db
    .select({ balance: accounts.balanceRial })
    .from(accounts)
    .where(sql`${accounts.id} = ${accountId}`);
  const balanceAfter = Number(current?.balance ?? 0);

  await db.insert(ledgerEntries).values([
    { transactionId: tx!.id, accountId, systemAccount: null, amountRial, balanceAfter },
    { transactionId: tx!.id, accountId: null, systemAccount: 'MANUAL_CASH', amountRial: -amountRial, balanceAfter: null },
  ]);
  return tx!.id;
}

/** ساخت رزرو خام (بدون عبور از سرویس) — برای تست تحویل/لغو/گزارش. */
export async function createReservationFixture(
  db: Db,
  options: { accountId: string; offeringId: string; status?: string; priceRial?: number; qrToken?: string; customerGroup?: string },
): Promise<string> {
  const [off] = await db
    .select({
      serviceDate: mealOfferings.serviceDate,
      mealSlotId: mealOfferings.mealSlotId,
      cafeteriaId: mealOfferings.cafeteriaId,
    })
    .from(mealOfferings)
    .where(sql`${mealOfferings.id} = ${options.offeringId}`)
    .limit(1);
  if (!off) throw new Error('وعده یافت نشد.');

  const [row] = await db
    .insert(reservations)
    .values({
      code: newReservationCode(),
      accountId: options.accountId,
      offeringId: options.offeringId,
      serviceDate: off.serviceDate,
      mealSlotId: off.mealSlotId,
      cafeteriaId: off.cafeteriaId,
      priceAtBooking: options.priceRial ?? 300_000,
      customerGroupAtBooking: options.customerGroup ?? 'Student',
      status: options.status ?? 'Reserved',
      idempotencyKey: `fixture:${randomHex(10)}`,
      qrToken: options.qrToken ?? randomHex(24),
      qrIssuedAt: new Date(),
      cancelReason: options.status === 'Cancelled' ? 'لغو آزمایشی' : null,
      cancelledAt: options.status === 'Cancelled' ? new Date() : null,
    })
    .returning({ id: reservations.id });
  return row!.id;
}

/**
 * وعدهٔ «امروز» که بازهٔ اسکن آن همین لحظه باز است.
 * ساعت وعدهٔ Lunch به بازهٔ [اکنون−۱ساعت، اکنون+۱ساعت] به وقت تهران تغییر می‌کند
 * تا تست تحویل مستقل از ساعت اجرای تست باشد.
 */
export async function createDeliverableOffering(
  db: Db,
  options: { capacity?: number; price?: number; groups?: Record<string, number> } = {},
): Promise<OfferingFixtureForDelivery> {
  const nowTehran = tehranParts();
  const nowMinutes = nowTehran.hour * 60 + nowTehran.minute;
  // نگه داشتن وعده در همان روز تقویمی تهران (تا تحویل با wrongDay مواجه نشود)
  // و در عین حال آینده نگه داشتن start_time نسبت به اکنون (تا رزرو مجاز بماند).
  const startMinutes = nowMinutes <= 23 * 60 + 58 ? Math.min(nowMinutes + 30, 23 * 60 + 58) : 23 * 60 + 59;
  const endMinutes = Math.min(Math.max(startMinutes + 1, nowMinutes + 150), 23 * 60 + 59);
  const start = shiftDayIfNeeded(startMinutes);
  const endTime = shiftDayIfNeeded(endMinutes).time;

  await db.execute(sql`UPDATE meal_slots SET start_time = ${start.time}::time, end_time = ${endTime}::time WHERE code = 'Lunch'`);

  const serviceDate = tehranToday();
  const offering = await createOffering(db, {
    serviceDate,
    mealSlot: 'Lunch',
    capacity: options.capacity ?? 50,
    prices: options.groups ?? { Student: options.price ?? 100_000 },
    reserveOpensAt: new Date(Date.now() - 6 * 3_600_000),
    reserveDeadline: new Date(Date.now() + 30 * 60_000),
  });
  return { ...offering, startTime: start.time, endTime };
}

export type OfferingFixtureForDelivery = OfferingFixture & { startTime: string; endTime: string };

let baseCache: BaseFixture | null = null;

/** base را یک بار می‌سازد و کش می‌کند. */
export async function ensureBase(db: Db): Promise<BaseFixture> {
  if (baseCache && baseCache.cafeteriaId) return baseCache;
  return seedBase(db);
}

/** تبدیل دقیقهٔ روز به `HH:mm:ss` با احتساب عبور از نیمه‌شب. */
function shiftDayIfNeeded(minutes: number): { time: string; dayOffset: number } {
  const dayOffset = Math.floor(minutes / (24 * 60));
  const m = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`, dayOffset };
}

/** پاک‌کردن کش base (پس از resetDatabase). */
export function resetBaseCache(): void {
  baseCache = null;
}
