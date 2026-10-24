import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, tehranDate, tehranWallToUtc } from '@food/shared';
import type { Db, Tx } from '../db/client.js';
import { requirePrincipal } from '../lib/auth.js';
import { iso, MEAL_TYPE, n, toDate } from '../lib/customer.js';
import { fail } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { cancelReservationInTx } from '../services/cancel.js';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const rialN = z.number().int().min(0).max(100_000_000);
const SLOT: Record<string, string> = { Breakfast: 'breakfast', Lunch: 'lunch', Dinner: 'dinner' };

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  serviceDate: z.string().regex(dateRe),
  mealType: z.enum(['Breakfast', 'Lunch', 'Dinner']),
  foodId: z.string().uuid(),
  cafeteriaId: z.string().uuid().optional(),
  priceRial: rialN.optional(), // "one price for all"
  prices: z.object({ Student: rialN, Employee: rialN }).partial().optional(),
  capacity: z.number().int().min(1).max(100_000),
  reserveDeadline: z.string().datetime({ offset: true }),
  cancelDeadline: z.string().datetime({ offset: true }).optional().nullable(),
  active: z.boolean(),
  notes: z.string().max(1000).default(''),
  reason: z.string().max(500).optional(),
});
export type SaveOffering = z.infer<typeof saveSchema>;

async function slotTimes(tx: Db | Tx, mealType: string) {
  const r = await tx.execute<{ id: string; start_time: string; end_time: string }>(
    sql`SELECT id, start_time, end_time FROM meal_slots WHERE code = ${SLOT[mealType]!}`,
  );
  if (!r.rows[0]) fail('BAD_REQUEST', 'وعده نامعتبر است.');
  return r.rows[0];
}
async function defaultCafeteria(tx: Db | Tx) {
  const r = await tx.execute<{ id: string }>(sql`SELECT id FROM cafeterias WHERE active ORDER BY created_at LIMIT 1`);
  if (!r.rows[0]) fail('BAD_REQUEST', 'ابتدا یک سلف تعریف کنید.');
  return r.rows[0].id;
}

export async function saveOffering(tx: Tx, actor: string, b: SaveOffering) {
  const slot = await slotTimes(tx, b.mealType);
  const starts = tehranWallToUtc(b.serviceDate, slot.start_time);
  const ends = tehranWallToUtc(b.serviceDate, slot.end_time);
  const deadline = new Date(b.reserveDeadline);
  if (deadline > starts) fail('BAD_REQUEST', 'مهلت رزرو باید قبل از شروع وعده باشد.');
  const prices = { Student: b.prices?.Student ?? b.priceRial, Employee: b.prices?.Employee ?? b.priceRial };
  if (prices.Student == null && prices.Employee == null) fail('BAD_REQUEST', 'حداقل یک قیمت لازم است.');
  const cafeteriaId = b.cafeteriaId ?? (await defaultCafeteria(tx));
  const status = b.active ? 'Published' : 'Draft';
  let id = b.id;
  if (id) {
    const cur = await tx.execute<{ status: string; reserved_count: number }>(
      sql`SELECT status, reserved_count FROM meal_offerings WHERE id = ${id} FOR UPDATE`,
    );
    const c = cur.rows[0];
    if (!c) fail('NOT_FOUND', 'وعده پیدا نشد.');
    if (c.status === 'Cancelled') fail('CONFLICT', 'وعده‌ی لغوشده قابل ویرایش نیست.');
    if (b.capacity < c.reserved_count) fail('BAD_REQUEST', `ظرفیت نمی‌تواند کمتر از تعداد رزروها (${c.reserved_count}) باشد.`);
    const old = await tx.execute<{ customer_group: string; price_rial: bigint }>(
      sql`SELECT customer_group, price_rial FROM offering_prices WHERE offering_id = ${id}`,
    );
    const changed = old.rows.some((r) => prices[r.customer_group as 'Student'] != null && BigInt(prices[r.customer_group as 'Student']!) !== r.price_rial);
    if (changed && c.status !== 'Draft' && !b.reason?.trim()) fail('BAD_REQUEST', 'تغییر قیمت وعده‌ی منتشرشده نیاز به ذکر دلیل دارد.');
    if (changed)
      await audit(tx, {
        actor,
        action: 'offering.price-change',
        entityType: 'MealOffering',
        entityId: id,
        data: { before: Object.fromEntries(old.rows.map((r) => [r.customer_group, r.price_rial.toString()])), after: prices, reason: b.reason ?? null },
      });
    await tx.execute(sql`UPDATE meal_offerings SET service_date=${b.serviceDate}, meal_slot_id=${slot.id}, food_id=${b.foodId}, cafeteria_id=${cafeteriaId}, capacity=${b.capacity},
      reserve_deadline=${deadline}, cancel_deadline=${b.cancelDeadline ? new Date(b.cancelDeadline) : null}, meal_starts_at=${starts}, meal_ends_at=${ends},
      status=(CASE WHEN status='SoldOut' THEN status ELSE ${status}::offering_status END), notes=${b.notes}, updated_at=now() WHERE id=${id}`);
  } else {
    const r = await tx.execute<{
      id: string;
    }>(sql`INSERT INTO meal_offerings (service_date, meal_slot_id, food_id, cafeteria_id, capacity, reserve_deadline, cancel_deadline, meal_starts_at, meal_ends_at, status, notes, created_by)
      VALUES (${b.serviceDate}, ${slot.id}, ${b.foodId}, ${cafeteriaId}, ${b.capacity}, ${deadline}, ${b.cancelDeadline ? new Date(b.cancelDeadline) : null}, ${starts}, ${ends}, ${status}::offering_status, ${b.notes}, NULL) RETURNING id`);
    id = r.rows[0]!.id;
  }
  for (const g of ['Student', 'Employee'] as const) {
    const pv = prices[g];
    if (pv == null) continue;
    await tx.execute(sql`INSERT INTO offering_prices (offering_id, customer_group, price_rial) VALUES (${id}, ${g}, ${String(pv)}::bigint)
      ON CONFLICT (offering_id, customer_group) DO UPDATE SET price_rial = EXCLUDED.price_rial, updated_at = now()`);
  }
  await audit(tx, {
    actor,
    action: b.id ? 'offering.update' : 'offering.create',
    entityType: 'MealOffering',
    entityId: id,
    data: { serviceDate: b.serviceDate, mealType: b.mealType, capacity: b.capacity, status },
  });
  return id!;
}

/** Bulk-cancels every Reserved reservation of an offering in batches of 100, refunding each. */
async function closeOffering(db: Db, actor: string, offeringId: string, mode: 'SoldOut' | 'Cancelled', reason: string) {
  let count = 0;
  let total = 0n;
  await db.transaction(async (tx) => {
    const r = await tx.execute(
      sql`UPDATE meal_offerings SET status=${mode}::offering_status, updated_at=now() WHERE id=${offeringId} AND status IN ('Published','SoldOut','Draft') RETURNING id`,
    );
    if (!r.rows[0]) fail('CONFLICT', 'این وعده قبلاً بسته یا لغو شده است.');
    await audit(tx, {
      actor,
      action: mode === 'SoldOut' ? 'offering.sold-out' : 'offering.cancel',
      entityType: 'MealOffering',
      entityId: offeringId,
      data: { reason },
    });
  });
  for (;;) {
    const batch = await db.execute<{ id: string }>(
      sql`SELECT id FROM reservations WHERE offering_id=${offeringId} AND status='Reserved' ORDER BY created_at LIMIT 100`,
    );
    if (batch.rows.length === 0) break;
    await db.transaction(async (tx) => {
      for (const row of batch.rows) {
        const out = await cancelReservationInTx(tx, row.id, actor, reason, mode === 'SoldOut' ? 'SoldOutRefund' : 'MealCancelledRefund');
        count++;
        total += out.refund;
        await tx.execute(
          sql`INSERT INTO notifications (account_id, title, body, kind) VALUES (${out.accountId}, ${mode === 'SoldOut' ? 'اتمام غذا' : 'لغو وعده'}, ${`${reason} — مبلغ ${out.refund.toString()} ریال به اعتبار شما برگشت.`}, 'refund')`,
        );
      }
    });
  }
  return { cancelled: count, refundedRial: n(total) };
}

export function offeringRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/v1/offerings', { config: { access: 'menuRead' } }, async (req) => {
    const p = requirePrincipal(req);
    const q = z
      .object({ from: z.string().regex(dateRe).optional(), to: z.string().regex(dateRe).optional(), cafeteriaId: z.string().uuid().optional() })
      .parse(req.query);
    const from = q.from ?? tehranDate();
    const to = q.to ?? addDays(from, 7);
    const cafeteria = p.role === 'Operator' ? p.cafeteriaId : (q.cafeteriaId ?? null);
    const contractor = p.role === 'Contractor' ? p.contractorId : null;
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT o.id, o.service_date, ms.code AS slot, o.food_id, f.name AS food_name, f.description AS food_description, o.cafeteria_id, cf.name AS cafeteria_name,
        o.capacity, o.reserved_count, o.status, o.reserve_deadline, o.cancel_deadline, o.notes,
        (SELECT price_rial FROM offering_prices WHERE offering_id=o.id AND customer_group='Student') AS price_student,
        (SELECT price_rial FROM offering_prices WHERE offering_id=o.id AND customer_group='Employee') AS price_employee,
        (SELECT count(*) FROM reservations r WHERE r.offering_id=o.id AND r.status='Delivered')::int AS delivered,
        (SELECT count(*) FROM reservations r WHERE r.offering_id=o.id AND r.status='NoShow')::int AS no_show
      FROM meal_offerings o JOIN meal_slots ms ON ms.id=o.meal_slot_id JOIN foods f ON f.id=o.food_id JOIN cafeterias cf ON cf.id=o.cafeteria_id
      WHERE o.service_date BETWEEN ${from} AND ${to} AND (${cafeteria}::uuid IS NULL OR o.cafeteria_id=${cafeteria}::uuid) AND (${contractor}::uuid IS NULL OR cf.contractor_id=${contractor}::uuid)
      ORDER BY o.service_date, ms.sort_order, f.name LIMIT 1000`);
    return {
      offerings: r.rows.map((o) => ({
        id: o.id,
        serviceDate: o.service_date,
        mealType: MEAL_TYPE[o.slot as string],
        foodId: o.food_id,
        foodName: o.food_name,
        foodDescription: o.food_description ?? '',
        cafeteriaId: o.cafeteria_id,
        cafeteriaName: o.cafeteria_name,
        priceRial: n((o.price_student ?? o.price_employee) as bigint),
        prices: {
          Student: o.price_student == null ? null : n(o.price_student as bigint),
          Employee: o.price_employee == null ? null : n(o.price_employee as bigint),
        },
        capacity: o.capacity,
        reserved: o.reserved_count,
        delivered: o.delivered,
        noShow: o.no_show,
        remaining: Number(o.capacity) - Number(o.reserved_count),
        status: o.status,
        active: o.status === 'Published',
        reserveDeadline: iso(o.reserve_deadline as Date),
        cancelDeadline: iso(o.cancel_deadline as Date),
        notes: o.notes ?? '',
      })),
    };
  });

  app.put('/api/v1/offerings', { config: { access: 'menuWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const b = saveSchema.parse(req.body);
    return { id: await db.transaction((tx) => saveOffering(tx, p.actor, b)) };
  });

  app.post('/api/v1/offerings/bulk', { config: { access: 'menuWrite' } }, async (req) => {
    const p = requirePrincipal(req);
    const b = z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('create'), items: z.array(saveSchema).min(1).max(200) }),
        z.object({
          mode: z.literal('copy'),
          sourceFrom: z.string().regex(dateRe),
          sourceTo: z.string().regex(dateRe),
          targetFrom: z.string().regex(dateRe),
          publish: z.boolean().default(false),
        }),
      ])
      .parse(req.body);
    return db.transaction(async (tx) => {
      if (b.mode === 'create') {
        const ids = [];
        for (const it of b.items) ids.push(await saveOffering(tx, p.actor, { ...it, id: undefined }));
        return { created: ids.length, ids };
      }
      const days = Math.round((Date.parse(b.sourceTo) - Date.parse(b.sourceFrom)) / 86400000);
      if (days < 0 || days > 13) fail('BAD_REQUEST', 'بازه‌ی کپی حداکثر دو هفته است.');
      const src = await tx.execute<Record<string, unknown>>(sql`
        SELECT o.*, ms.code AS slot FROM meal_offerings o JOIN meal_slots ms ON ms.id=o.meal_slot_id
        WHERE o.service_date BETWEEN ${b.sourceFrom} AND ${b.sourceTo} AND o.status <> 'Cancelled'`);
      const shift = Math.round((Date.parse(b.targetFrom) - Date.parse(b.sourceFrom)) / 86400000);
      const ids = [];
      for (const o of src.rows) {
        const prices = await tx.execute<{ customer_group: 'Student' | 'Employee'; price_rial: bigint }>(
          sql`SELECT customer_group, price_rial FROM offering_prices WHERE offering_id=${o.id as string}`,
        );
        const date = addDays(o.service_date as string, shift);
        const msBefore = toDate(o.meal_starts_at).getTime() - toDate(o.reserve_deadline).getTime();
        const slot = await slotTimes(tx, MEAL_TYPE[o.slot as string]!);
        const starts = tehranWallToUtc(date, slot.start_time);
        ids.push(
          await saveOffering(tx, p.actor, {
            serviceDate: date,
            mealType: MEAL_TYPE[o.slot as string]!,
            foodId: o.food_id as string,
            cafeteriaId: o.cafeteria_id as string,
            capacity: o.capacity as number,
            reserveDeadline: new Date(starts.getTime() - msBefore).toISOString(),
            cancelDeadline: null,
            active: b.publish,
            notes: (o.notes as string) ?? '',
            prices: Object.fromEntries(prices.rows.map((x) => [x.customer_group, Number(x.price_rial)])),
          }),
        );
      }
      return { created: ids.length, ids };
    });
  });

  for (const [path, mode] of [
    ['sold-out', 'SoldOut'],
    ['cancel', 'Cancelled'],
  ] as const) {
    app.post(`/api/v1/offerings/:id/${path}`, { config: { access: 'reservationsAdminCancel' } }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z.object({ reason: z.string().trim().min(3).max(300), confirm: z.string() }).parse(req.body);
      if (b.confirm !== 'تایید') fail('BAD_REQUEST', 'برای تأیید، کلمه‌ی «تایید» را تایپ کنید.');
      return closeOffering(db, p.actor, id, mode, b.reason);
    });
  }

  app.post('/api/v1/reservations/:id/cancel', { config: { access: 'reservationsAdminCancel' } }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return db.transaction(async (tx) => {
      const out = await cancelReservationInTx(tx, id, p.actor, `لغو اداری: ${b.reason}`);
      await tx.execute(
        sql`INSERT INTO notifications (account_id, title, body, kind) VALUES (${out.accountId}, 'لغو رزرو', ${`رزرو شما لغو شد (${b.reason}) و مبلغ ${out.refund.toString()} ریال به اعتبار شما برگشت.`}, 'refund')`,
      );
      return { ok: true, refundRial: n(out.refund) };
    });
  });
}
