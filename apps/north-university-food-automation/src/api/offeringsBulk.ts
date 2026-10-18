import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, defaultCafeteriaId, fail, requireStaff, staffActor } from '../server/core';
import { queryOfferings } from '../server/queries';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const key = (o: { serviceDate: string; mealType: string; cafeteriaId: string; foodId: string }) => `${o.serviceDate}|${o.mealType}|${o.cafeteriaId}|${o.foodId}`;

/**
 * Two ways to build menus fast:
 *  - mode "items": create a whole day's (or several days') menu in one go from the food library
 *  - mode "copy": copy every offering in a source date range to a target start date (deadlines shift by the same number of days)
 * Exact duplicates (same date + meal + cafeteria + food) are skipped, never doubled.
 */
export default createEndpoint({
  description: 'Bulk-creates meal offerings for a day/week or copies an existing menu range to new dates',
  inputSchema: z.object({
    token: z.string(),
    mode: z.enum(['items', 'copy']),
    items: z.array(z.object({
      serviceDate: day, mealType: z.enum(['Breakfast', 'Lunch', 'Dinner']), foodId: z.string().uuid(), cafeteriaId: z.string().uuid().optional(),
      priceRial: z.number().int().min(0).max(100_000_000), capacity: z.number().int().min(1).max(100_000),
      reserveDeadline: z.string(), cancelDeadline: z.string().optional(), notes: z.string().max(1000).default(''),
    })).max(300).optional(),
    sourceFrom: day.optional(), sourceTo: day.optional(), targetStart: day.optional(), repeat: z.number().int().min(1).max(12).default(1),
  }),
  outputSchema: z.object({ created: z.number(), skipped: z.number() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'menu');
    type Rec = { serviceDate: string; mealType: string; foodId: string; cafeteriaId: string; priceRial: number; capacity: number; reserveDeadline: string; cancelDeadline: string; notes: string };
    let recs: Rec[] = [];
    if (input.mode === 'items') {
      if (!input.items?.length) fail('BAD_REQUEST', 'حداقل یک غذا برای منو انتخاب کنید.');
      const defCaf = input.items.some((i) => !i.cafeteriaId) ? await defaultCafeteriaId() : '';
      recs = input.items.map((i) => ({ ...i, cafeteriaId: i.cafeteriaId ?? defCaf, reserveDeadline: new Date(i.reserveDeadline).toISOString(), cancelDeadline: new Date(i.cancelDeadline ?? i.reserveDeadline).toISOString() }));
    } else {
      if (!input.sourceFrom || !input.sourceTo || !input.targetStart) fail('BAD_REQUEST', 'بازه‌ی مبدأ و تاریخ مقصد را مشخص کنید.');
      if (input.sourceTo < input.sourceFrom) fail('BAD_REQUEST', 'تاریخ پایان مبدأ باید بعد از شروع باشد.');
      const src = await queryOfferings({ from: input.sourceFrom, to: input.sourceTo });
      if (!src.length) fail('BAD_REQUEST', 'در بازه‌ی مبدأ هیچ وعده‌ای وجود ندارد.');
      const span = Math.round((+new Date(`${input.sourceTo}T00:00:00Z`) - +new Date(`${input.sourceFrom}T00:00:00Z`)) / 86400000) + 1;
      const base = Math.round((+new Date(`${input.targetStart}T00:00:00Z`) - +new Date(`${input.sourceFrom}T00:00:00Z`)) / 86400000);
      if (base > 0 && base < span) fail('BAD_REQUEST', 'بازه‌ی مقصد با بازه‌ی مبدأ هم‌پوشانی دارد.');
      for (let r = 0; r < input.repeat; r++) {
        const shift = base + r * span;
        const ms = shift * 86400000;
        for (const o of src) {
          if (!o.foodId || !o.cafeteriaId) continue;
          recs.push({
            serviceDate: addDays(o.serviceDate, shift), mealType: o.mealType, foodId: o.foodId, cafeteriaId: o.cafeteriaId, priceRial: o.priceRial, capacity: o.capacity,
            reserveDeadline: new Date(+new Date(o.reserveDeadline ?? `${o.serviceDate}T00:00:00Z`) + ms).toISOString(),
            cancelDeadline: new Date(+new Date(o.cancelDeadline ?? `${o.serviceDate}T00:00:00Z`) + ms).toISOString(), notes: o.notes ?? '',
          });
        }
      }
    }
    if (recs.some((r) => isNaN(+new Date(r.reserveDeadline)) || isNaN(+new Date(r.cancelDeadline)))) fail('BAD_REQUEST', 'مهلت‌ها نامعتبر هستند.');
    if (recs.length > 1000) fail('BAD_REQUEST', 'حداکثر ۱۰۰۰ وعده در هر عملیات قابل ساخت است.');
    const foodIds = [...new Set(recs.map((r) => r.foodId))];
    const foods = await zite.sql({ query: `SELECT id FROM "Foods" WHERE id = ANY($1::uuid[])`, params: [foodIds] });
    if (foods.rows.length !== foodIds.length) fail('BAD_REQUEST', 'یکی از غذاهای انتخاب‌شده معتبر نیست.');

    const dates = recs.map((r) => r.serviceDate).sort();
    const existing = new Set((await queryOfferings({ from: dates[0], to: dates[dates.length - 1] })).map(key));
    const seen = new Set<string>();
    const fresh = recs.filter((r) => { const k = key(r); if (existing.has(k) || seen.has(k)) return false; seen.add(k); return true; });
    for (let i = 0; i < fresh.length; i += 100) {
      await db.mealOfferings.bulkCreate({
        records: fresh.slice(i, i + 100).map((r) => ({
          serviceDate: r.serviceDate, mealType: r.mealType, food: [r.foodId], cafeteria: [r.cafeteriaId], priceRial: r.priceRial, capacity: r.capacity,
          reserveDeadline: r.reserveDeadline, cancelDeadline: r.cancelDeadline, active: true, notes: r.notes,
        })),
      });
    }
    await audit(staffActor(staff), `offering.bulk.${input.mode}`, 'MealOffering', '-', { created: fresh.length, skipped: recs.length - fresh.length, sourceFrom: input.sourceFrom, targetStart: input.targetStart });
    return { created: fresh.length, skipped: recs.length - fresh.length };
  },
});
