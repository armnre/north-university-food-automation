import { addDays, tehranDateTimeToUtc, tehranToday } from '@food/shared';
import { accounts, cafeterias, contractors, foods, mealOfferings, mealSlots, offeringPrices, students } from './schema/index.js';
import type { Db } from './client.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { getEnv } from '../config/env.js';

/**
 * seed **دمو** — فقط برای توسعهٔ محلی.
 *
 * نگهبان‌ها:
 *  - فقط وقتی `NODE_ENV === 'development'` و `ALLOW_DEMO_SEED === true` اجرا می‌شود.
 *  - در production فراخوانی آن با خطا متوقف می‌شود.
 *  - کد ملی‌های دمو ساختگی و معتبر هستند اما متعلق به شخص واقعی نیستند؛
 *    فقط hash و ۴ رقم آخر ذخیره می‌شود.
 */
export type DemoSeedResult = { students: { studentNumber: string; nationalId: string }[]; offerings: number };

export async function seedDemo(db: Db): Promise<DemoSeedResult> {
  const env = getEnv();
  if (env.NODE_ENV !== 'development' || !env.ALLOW_DEMO_SEED) {
    throw new Error('seed دمو فقط در محیط توسعه و با ALLOW_DEMO_SEED=true مجاز است.');
  }

  const [contractor] = await db
    .insert(contractors)
    .values({ name: 'پیمانکار نمونه (دمو)', contractNumber: 'DEMO-1', isActive: true })
    .onConflictDoNothing()
    .returning({ id: contractors.id });
  const contractorId = contractor?.id ?? null;

  const [cafeteria] = await db
    .insert(cafeterias)
    .values({ name: 'سلف دمو', location: 'پردیس مرکزی', contractorId, isActive: true })
    .onConflictDoNothing()
    .returning({ id: cafeterias.id });
  const cafeteriaId = cafeteria?.id ?? (await db.select({ id: cafeterias.id }).from(cafeterias).limit(1))[0]?.id ?? '';

  const foodNames = ['چلوکباب کوبیده', 'زرشک‌پلو با مرغ', 'خورش قورمه‌سبزی', 'ماکارونی', 'عدس‌پلو'];
  const foodIds: string[] = [];
  for (const [index, name] of foodNames.entries()) {
    const [food] = await db
      .insert(foods)
      .values({
        name: `${name} (دمو)`,
        description: 'غذای نمونه برای محیط توسعه',
        category: 'غذای اصلی',
        calories: 600 + index * 50,
        defaultPriceRial: 300_000,
        defaultCapacity: 50,
        isActive: true,
      })
      .onConflictDoNothing()
      .returning({ id: foods.id });
    if (food) foodIds.push(food.id);
  }

  const slots = await db.select().from(mealSlots);
  const today = tehranToday();
  let offeringCount = 0;
  for (let day = 0; day < 3; day += 1) {
    const serviceDate = addDays(today, day);
    for (const [index, slot] of slots.entries()) {
      const foodId = foodIds[(day + index) % foodIds.length];
      if (!foodId) continue;
      const [created] = await db
        .insert(mealOfferings)
        .values({
          serviceDate,
          mealSlotId: slot.id,
          foodId,
          cafeteriaId,
          capacity: 50,
          reservedCount: 0,
          reserveOpensAt: tehranDateTimeToUtc(addDays(today, -1), '08:00'),
          reserveDeadline: tehranDateTimeToUtc(serviceDate, String(slot.startTime).slice(0, 5)),
          cancelDeadline: null,
          status: 'Published',
          notes: '',
          publishedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: mealOfferings.id });
      if (!created) continue;
      offeringCount += 1;
      await db.insert(offeringPrices).values([
        { offeringId: created.id, customerGroup: 'Student', priceRial: 150_000 },
        { offeringId: created.id, customerGroup: 'Employee', priceRial: 450_000 },
        { offeringId: created.id, customerGroup: 'Faculty', priceRial: 600_000 },
      ]);
    }
  }

  const demoStudents: { studentNumber: string; nationalId: string }[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const studentNumber = `40010000${i}`;
    const nationalId = demoNationalId(i);
    const [student] = await db
      .insert(students)
      .values({
        studentNumber,
        fullName: `دانشجوی نمونه ${i}`,
        faculty: 'فنی و مهندسی',
        major: 'مهندسی کامپیوتر',
        degree: 'کارشناسی',
        entryYear: 1402,
        nationalIdHash: hmacSha256Hex(env.NATIONAL_ID_PEPPER, nationalId),
        nationalIdLast4: nationalId.slice(-4),
        status: 'Active',
      })
      .onConflictDoNothing()
      .returning({ id: students.id });
    if (!student) continue;
    await db
      .insert(accounts)
      .values({ kind: 'Student', studentId: student.id, customerGroup: 'Student', balanceRial: 0, isActive: true })
      .onConflictDoNothing();
    demoStudents.push({ studentNumber, nationalId });
  }

  return { students: demoStudents, offerings: offeringCount };
}

/** کد ملی ساختگی اما با رقم کنترلی معتبر (فقط برای توسعه). */
function demoNationalId(seed: number): string {
  const base = String(123456780 + seed).slice(0, 9);
  const sum = base.split('').reduce((acc, digit, index) => acc + Number(digit) * (10 - index), 0);
  const rest = sum % 11;
  const check = rest < 2 ? rest : 11 - rest;
  return `${base}${check}`;
}
