import { eq, sql } from 'drizzle-orm';
import { addDays, tehranDateTimeToUtc } from '@food/shared';
import { mealOfferings, offeringPrices } from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import { getOfferingById, queryOfferings, type OfferingRow } from '../repositories/offering.repo.js';
import type { Actor, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { defaultCafeteriaId, getMealSlotByCode, recordPriceHistory } from './catalog.service.js';
import { rawSql } from '../db/raw.js';

/**
 * مدیریت منو: ساخت/ویرایش آیتم منو، قیمت‌گذاری هر گروه مشتری، ساخت دسته‌ای و کپی منو.
 *
 * قاعدهٔ کلیدی: تغییر قیمت پس از انتشار، رزروهای قبلی را تغییر نمی‌دهد
 * (هر رزرو `price_at_booking` دارد) و با تأیید + ممیزی انجام می‌شود.
 */

export type PriceInput = { all?: number; Student?: number; Employee?: number; Faculty?: number; Contractor?: number };

export function normalizePrices(input: PriceInput): Record<string, number> {
  const out: Record<string, number> = {};
  for (const group of ['Student', 'Employee', 'Faculty', 'Contractor'] as const) {
    const explicit = input[group];
    const value = explicit ?? input.all;
    if (value != null) out[group] = Math.trunc(Number(value));
  }
  if (Object.keys(out).length === 0) {
    throw new AppError('VALIDATION', 'حداقل یک قیمت (یا «یک قیمت برای همهٔ گروه‌ها») الزامی است.');
  }
  return out;
}

export type OfferingUpsertInput = {
  id?: string;
  serviceDate: string;
  mealSlot: string;
  foodId: string;
  cafeteriaId?: string;
  capacity: number;
  reserveOpensAt?: string;
  reserveDeadline: string;
  cancelDeadline?: string | null;
  status: string;
  notes: string;
  prices: PriceInput;
  reason?: string;
  actor: Actor;
  staffId: string;
  ip: string;
};

export async function saveOffering(deps: ServiceDeps, input: OfferingUpsertInput): Promise<{ id: string }> {
  const prices = normalizePrices(input.prices);
  const cafeteriaId = input.cafeteriaId ?? (await defaultCafeteriaId(deps.db));
  const slot = await getMealSlotByCode(deps.db, input.mealSlot);
  if (!slot) fail('VALIDATION', 'وعدهٔ انتخاب‌شده معتبر نیست.');

  const reserveDeadline = new Date(input.reserveDeadline);
  const cancelDeadline = input.cancelDeadline ? new Date(input.cancelDeadline) : null;
  const reserveOpensAt = input.reserveOpensAt ? new Date(input.reserveOpensAt) : defaultReserveOpensAt(input.serviceDate, slot.startTime);
  if (
    Number.isNaN(reserveDeadline.getTime()) ||
    (cancelDeadline && Number.isNaN(cancelDeadline.getTime())) ||
    Number.isNaN(reserveOpensAt.getTime())
  ) {
    fail('VALIDATION', 'مهلت‌های واردشده معتبر نیستند.');
  }
  if (reserveDeadline.getTime() < reserveOpensAt.getTime()) {
    fail('VALIDATION', 'مهلت پایان رزرو نمی‌تواند پیش از زمان باز شدن رزرو باشد.');
  }

  return deps.db.transaction(async (tx) => {
    const food = await tx.execute(rawSql(`SELECT id FROM foods WHERE id = $1 AND deleted_at IS NULL`, [input.foodId]));
    if (((food as unknown as { rows: unknown[] }).rows ?? []).length === 0) fail('VALIDATION', 'غذای انتخاب‌شده معتبر نیست.');
    const cafeteria = await tx.execute(rawSql(`SELECT id FROM cafeterias WHERE id = $1`, [cafeteriaId]));
    if (((cafeteria as unknown as { rows: unknown[] }).rows ?? []).length === 0) fail('VALIDATION', 'سلف انتخاب‌شده معتبر نیست.');

    let offeringId = input.id;

    if (offeringId) {
      const current = await getOfferingById(tx, offeringId);
      if (!current) fail('NOT_FOUND', 'وعده یافت نشد.');
      if (input.capacity < current.reservedCount) {
        fail('VALIDATION', `ظرفیت نمی‌تواند کمتر از تعداد رزروهای فعلی (${current.reservedCount}) باشد.`);
      }

      await tx
        .update(mealOfferings)
        .set({
          serviceDate: input.serviceDate,
          mealSlotId: slot.id,
          foodId: input.foodId,
          cafeteriaId,
          capacity: input.capacity,
          reserveOpensAt,
          reserveDeadline,
          cancelDeadline,
          status: input.status,
          notes: input.notes ?? '',
          publishedAt: input.status === 'Published' ? (current.publishedAt ?? new Date()) : current.publishedAt,
        })
        .where(eq(mealOfferings.id, offeringId));

      // قیمت‌ها: حذف گروه‌های حذف‌شده و به‌روزرسانی/درج بقیه
      const existingPrices = await tx.select().from(offeringPrices).where(eq(offeringPrices.offeringId, offeringId));
      for (const row of existingPrices) {
        if (!(row.customerGroup in prices)) {
          // حذف ردیف قیمت ممکن است (رکورد مالی نیست؛ رزروهای قبلی قیمت خود را دارند)
          await tx.execute(
            rawSql(`DELETE FROM offering_prices WHERE offering_id = $1 AND customer_group = $2`, [offeringId, row.customerGroup]),
          );
        }
      }
      for (const [group, price] of Object.entries(prices)) {
        const previous = existingPrices.find((p) => p.customerGroup === group);
        await tx
          .insert(offeringPrices)
          .values({ offeringId, customerGroup: group, priceRial: price, updatedBy: input.staffId })
          .onConflictDoUpdate({
            target: [offeringPrices.offeringId, offeringPrices.customerGroup],
            set: { priceRial: price, updatedBy: input.staffId },
          });
        if (current.reservedCount > 0 && (previous == null || Number(previous.priceRial) !== price)) {
          if (!input.reason) {
            fail('VALIDATION', 'تغییر قیمت وعده‌ای که رزرو فعال دارد، نیازمند ذکر دلیل است.');
          }
          await recordPriceHistory(tx, {
            offeringId,
            customerGroup: group,
            fromPriceRial: previous ? Number(previous.priceRial) : null,
            toPriceRial: price,
            changedBy: input.staffId,
            reason: input.reason,
          });
        }
      }

      await writeAudit(tx, {
        actor: input.actor,
        action: 'offering.update',
        targetType: 'MealOffering',
        targetId: offeringId,
        details: {
          fromPrice: current.prices,
          toPrice: prices,
          fromCapacity: current.capacity,
          toCapacity: input.capacity,
          status: input.status,
          reason: input.reason,
        },
        ip: input.ip,
      });
      return { id: offeringId };
    }

    const [created] = await tx
      .insert(mealOfferings)
      .values({
        serviceDate: input.serviceDate,
        mealSlotId: slot.id,
        foodId: input.foodId,
        cafeteriaId,
        capacity: input.capacity,
        reservedCount: 0,
        reserveOpensAt,
        reserveDeadline,
        cancelDeadline,
        status: input.status,
        notes: input.notes ?? '',
        publishedAt: input.status === 'Published' ? new Date() : null,
        createdBy: input.staffId,
      })
      .onConflictDoNothing()
      .returning({ id: mealOfferings.id });

    if (!created) {
      const duplicate = await tx
        .select({ id: mealOfferings.id })
        .from(mealOfferings)
        .where(
          sql`${mealOfferings.serviceDate} = ${input.serviceDate} AND ${mealOfferings.mealSlotId} = ${slot.id} AND ${mealOfferings.cafeteriaId} = ${cafeteriaId} AND ${mealOfferings.foodId} = ${input.foodId}`,
        )
        .limit(1);
      if (duplicate[0]) fail('CONFLICT', 'این وعده قبلاً برای همین روز، وعده، سلف و غذا ثبت شده است.');
      fail('CONFLICT', 'ثبت وعده ممکن نشد.');
    }
    offeringId = created.id;

    await tx.insert(offeringPrices).values(
      Object.entries(prices).map(([group, price]) => ({
        offeringId: created.id,
        customerGroup: group,
        priceRial: price,
        updatedBy: input.staffId,
      })),
    );

    await writeAudit(tx, {
      actor: input.actor,
      action: 'offering.create',
      targetType: 'MealOffering',
      targetId: offeringId,
      details: { serviceDate: input.serviceDate, mealSlot: input.mealSlot, capacity: input.capacity, prices, status: input.status },
      ip: input.ip,
    });
    return { id: offeringId };
  });
}

function defaultReserveOpensAt(serviceDate: string, _slotStartTime: string): Date {
  // پیش‌فرض: باز شدن رزرو از ۷ روز قبل، ساعت ۰۰:۰۰ تهران
  return new Date(tehranDateTimeToUtc(addDays(serviceDate, -7), '00:00').getTime());
}

export type BulkItem = {
  serviceDate: string;
  mealSlot: string;
  foodId: string;
  cafeteriaId?: string;
  capacity: number;
  reserveDeadline: string;
  cancelDeadline?: string;
  notes: string;
  prices: PriceInput;
  status: string;
};

export type BulkInput = {
  mode: 'items' | 'copy';
  items?: BulkItem[];
  sourceFrom?: string;
  sourceTo?: string;
  targetStart?: string;
  repeat?: number;
  actor: Actor;
  staffId: string;
  ip: string;
};

/** ساخت دسته‌ای منو (یک روز/هفته) یا کپی یک بازه به تاریخ جدید. */
export async function bulkCreateOfferings(deps: ServiceDeps, input: BulkInput): Promise<{ created: number; skipped: number }> {
  type Rec = BulkItem & { cafeteriaId: string };
  let records: Rec[] = [];

  if (input.mode === 'items') {
    if (!input.items?.length) fail('VALIDATION', 'حداقل یک غذا برای منو انتخاب کنید.');
    const fallbackCafeteria = await defaultCafeteriaId(deps.db);
    records = input.items.map((item) => ({ ...item, cafeteriaId: item.cafeteriaId ?? fallbackCafeteria }));
  } else {
    if (!input.sourceFrom || !input.sourceTo || !input.targetStart) fail('VALIDATION', 'بازهٔ مبدأ و تاریخ مقصد را مشخص کنید.');
    if (input.sourceTo < input.sourceFrom) fail('VALIDATION', 'تاریخ پایان مبدأ باید بعد از شروع باشد.');
    const source = await queryOfferings(deps.db, { from: input.sourceFrom, to: input.sourceTo });
    if (source.length === 0) fail('VALIDATION', 'در بازهٔ مبدأ هیچ وعده‌ای وجود ندارد.');

    const span = daysBetween(input.sourceFrom, input.sourceTo) + 1;
    const base = daysBetween(input.sourceFrom, input.targetStart);
    if (base > 0 && base < span) fail('VALIDATION', 'بازهٔ مقصد با بازهٔ مبدأ هم‌پوشانی دارد.');

    const repeat = input.repeat ?? 1;
    for (let r = 0; r < repeat; r += 1) {
      const shift = base + r * span;
      const shiftMs = shift * 86_400_000;
      for (const offering of source) {
        records.push({
          serviceDate: addDays(offering.serviceDate, shift),
          mealSlot: offering.mealSlot,
          foodId: offering.foodId,
          cafeteriaId: offering.cafeteriaId,
          capacity: offering.capacity,
          reserveDeadline: new Date(offering.reserveDeadline.getTime() + shiftMs).toISOString(),
          cancelDeadline: offering.cancelDeadline ? new Date(offering.cancelDeadline.getTime() + shiftMs).toISOString() : undefined,
          notes: offering.notes,
          prices: Object.fromEntries(offering.prices.map((p) => [p.customerGroup, p.priceRial])),
          status: offering.status === 'Draft' ? 'Draft' : 'Published',
        });
      }
    }
  }

  if (records.length > 1000) fail('VALIDATION', 'حداکثر ۱۰۰۰ وعده در هر عملیات قابل ساخت است.');
  if (records.length === 0) return { created: 0, skipped: 0 };

  const dates = records.map((r) => r.serviceDate).sort();
  const existing = new Set(
    (await queryOfferings(deps.db, { from: dates[0], to: dates[dates.length - 1] })).map(
      (o) => `${o.serviceDate}|${o.mealSlot}|${o.cafeteriaId}|${o.foodId}`,
    ),
  );

  let created = 0;
  let skipped = 0;
  const seen = new Set<string>();

  await deps.db.transaction(async (tx) => {
    for (const record of records) {
      const key = `${record.serviceDate}|${record.mealSlot}|${record.cafeteriaId}|${record.foodId}`;
      if (existing.has(key) || seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const slot = await getMealSlotByCode(tx, record.mealSlot);
      if (!slot) {
        skipped += 1;
        continue;
      }
      const prices = normalizePrices(record.prices);
      const [createdRow] = await tx
        .insert(mealOfferings)
        .values({
          serviceDate: record.serviceDate,
          mealSlotId: slot.id,
          foodId: record.foodId,
          cafeteriaId: record.cafeteriaId,
          capacity: record.capacity,
          reservedCount: 0,
          reserveOpensAt: defaultReserveOpensAt(record.serviceDate, slot.startTime),
          reserveDeadline: new Date(record.reserveDeadline),
          cancelDeadline: record.cancelDeadline ? new Date(record.cancelDeadline) : null,
          status: record.status,
          notes: record.notes ?? '',
          publishedAt: record.status === 'Published' ? new Date() : null,
          createdBy: input.staffId,
        })
        .onConflictDoNothing()
        .returning({ id: mealOfferings.id });
      if (!createdRow) {
        skipped += 1;
        continue;
      }
      await tx.insert(offeringPrices).values(
        Object.entries(prices).map(([group, price]) => ({
          offeringId: createdRow.id,
          customerGroup: group,
          priceRial: price,
          updatedBy: input.staffId,
        })),
      );
      created += 1;
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: `offering.bulk.${input.mode}`,
      targetType: 'MealOffering',
      targetId: '',
      details: {
        created,
        skipped,
        sourceFrom: input.sourceFrom,
        sourceTo: input.sourceTo,
        targetStart: input.targetStart,
        repeat: input.repeat ?? 1,
      },
      ip: input.ip,
    });
  });

  return { created, skipped };
}

/** فهرست وعده‌ها با شمارنده‌های زنده و قیمت‌ها. */
export async function listOfferings(
  deps: ServiceDeps,
  filters: {
    from?: string;
    to?: string;
    cafeteriaId?: string;
    mealSlot?: string;
    status?: string;
    foodId?: string;
    cafeteriaIds?: string[];
  },
): Promise<OfferingRow[]> {
  return queryOfferings(deps.db, filters);
}

export async function getOffering(deps: ServiceDeps, id: string): Promise<OfferingRow> {
  const offering = await getOfferingById(deps.db, id);
  if (!offering) fail('NOT_FOUND', 'وعده یافت نشد.');
  return offering;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
