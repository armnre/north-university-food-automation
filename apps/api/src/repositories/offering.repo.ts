import type { Db, Tx } from '../db/client.js';
import { rawSql } from '../db/raw.js';

/**
 * لایهٔ repository برای آیتم‌های منو (فقط پرس‌وجوی Drizzle/SQL؛ بدون منطق کسب‌وکار).
 */

export type OfferingRow = {
  id: string;
  serviceDate: string;
  mealSlot: string;
  mealSlotTitle: string;
  mealSlotId: string;
  slotStartTime: string;
  slotEndTime: string;
  foodId: string;
  foodName: string;
  foodDescription: string;
  foodImagePath: string | null;
  cafeteriaId: string;
  cafeteriaName: string;
  capacity: number;
  reservedCount: number;
  delivered: number;
  cancelled: number;
  noShow: number;
  remaining: number;
  status: string;
  notes: string;
  statusReason: string | null;
  reserveOpensAt: Date;
  reserveDeadline: Date;
  cancelDeadline: Date | null;
  publishedAt: Date | null;
  prices: { customerGroup: string; priceRial: number }[];
};

export type OfferingFilters = {
  from?: string;
  to?: string;
  cafeteriaId?: string;
  cafeteriaIds?: string[];
  mealSlot?: string;
  status?: string;
  foodId?: string;
  id?: string;
  onlyBookable?: boolean;
  limit?: number;
};

const LIMIT_DEFAULT = 1000;

export async function queryOfferings(target: Db | Tx, filters: OfferingFilters = {}): Promise<OfferingRow[]> {
  const conditions: unknown[] = [];
  const where: string[] = ['o.deleted_at IS NULL'];
  const push = (fragment: string, ...params: unknown[]) => {
    where.push(fragment);
    conditions.push(...params);
  };

  if (filters.id) push('o.id = ' + placeholder(conditions, filters.id));
  if (filters.from) push('o.service_date >= ' + placeholder(conditions, filters.from) + '::date');
  if (filters.to) push('o.service_date <= ' + placeholder(conditions, filters.to) + '::date');
  if (filters.cafeteriaId) push('c.id = ' + placeholder(conditions, filters.cafeteriaId) + '::uuid');
  if (filters.cafeteriaIds?.length) push('c.id = ANY(' + placeholder(conditions, filters.cafeteriaIds) + '::uuid[])');
  if (filters.mealSlot) push('ms.code = ' + placeholder(conditions, filters.mealSlot));
  if (filters.status) push('o.status = ' + placeholder(conditions, filters.status));
  if (filters.foodId) push('f.id = ' + placeholder(conditions, filters.foodId) + '::uuid');
  if (filters.onlyBookable) push(`o.status = 'Published'`);

  const limit = Math.min(filters.limit ?? LIMIT_DEFAULT, LIMIT_DEFAULT);

  const result = await target.execute(
    rawSql(
      `SELECT o.id, o.service_date AS "serviceDate", o.capacity, o.reserved_count AS "reservedCount", o.status, o.notes,
              o.status_reason AS "statusReason", o.reserve_opens_at AS "reserveOpensAt", o.reserve_deadline AS "reserveDeadline",
              o.cancel_deadline AS "cancelDeadline", o.published_at AS "publishedAt",
              ms.id AS "mealSlotId", ms.code AS "mealSlot", ms.title AS "mealSlotTitle", ms.start_time AS "slotStartTime", ms.end_time AS "slotEndTime",
              f.id AS "foodId", f.name AS "foodName", f.description AS "foodDescription", f.image_path AS "foodImagePath",
              c.id AS "cafeteriaId", c.name AS "cafeteriaName",
              (SELECT COUNT(*) FROM reservations r WHERE r.offering_id = o.id AND r.status = 'Delivered')::int AS delivered,
              (SELECT COUNT(*) FROM reservations r WHERE r.offering_id = o.id AND r.status = 'Cancelled')::int AS cancelled,
              (SELECT COUNT(*) FROM reservations r WHERE r.offering_id = o.id AND r.status = 'NoShow')::int AS "noShow"
       FROM meal_offerings o
       JOIN meal_slots ms ON ms.id = o.meal_slot_id
       JOIN foods f ON f.id = o.food_id
       JOIN cafeterias c ON c.id = o.cafeteria_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.service_date ASC, ms.sort_order ASC, c.name ASC
       LIMIT ${limit}`,
      conditions,
    ),
  );

  const rows = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r.id));
  const priceResult = await target.execute(
    rawSql(
      `SELECT offering_id AS "offeringId", customer_group AS "customerGroup", price_rial::text AS "priceRial"
             FROM offering_prices WHERE offering_id = ANY($1::uuid[])`,
      [ids],
    ),
  );
  const priceRows = ((priceResult as unknown as { rows: { offeringId: string; customerGroup: string; priceRial: string }[] }).rows ??
    []) as {
    offeringId: string;
    customerGroup: string;
    priceRial: string;
  }[];
  const pricesByOffering = new Map<string, { customerGroup: string; priceRial: number }[]>();
  for (const p of priceRows) {
    const list = pricesByOffering.get(p.offeringId) ?? [];
    list.push({ customerGroup: p.customerGroup, priceRial: Number(p.priceRial) });
    pricesByOffering.set(p.offeringId, list);
  }

  return rows.map((r) => {
    const capacity = Number(r.capacity ?? 0);
    const reservedCount = Number(r.reservedCount ?? 0);
    return {
      id: String(r.id),
      serviceDate: String(r.serviceDate ?? '').slice(0, 10),
      mealSlot: String(r.mealSlot ?? ''),
      mealSlotTitle: String(r.mealSlotTitle ?? ''),
      mealSlotId: String(r.mealSlotId ?? ''),
      slotStartTime: String(r.slotStartTime ?? ''),
      slotEndTime: String(r.slotEndTime ?? ''),
      foodId: String(r.foodId ?? ''),
      foodName: String(r.foodName ?? ''),
      foodDescription: String(r.foodDescription ?? ''),
      foodImagePath: r.foodImagePath == null ? null : String(r.foodImagePath),
      cafeteriaId: String(r.cafeteriaId ?? ''),
      cafeteriaName: String(r.cafeteriaName ?? ''),
      capacity,
      reservedCount,
      delivered: Number(r.delivered ?? 0),
      cancelled: Number(r.cancelled ?? 0),
      noShow: Number(r.noShow ?? 0),
      remaining: Math.max(0, capacity - reservedCount),
      status: String(r.status ?? ''),
      notes: String(r.notes ?? ''),
      statusReason: r.statusReason == null ? null : String(r.statusReason),
      reserveOpensAt: toDate(r.reserveOpensAt),
      reserveDeadline: toDate(r.reserveDeadline),
      cancelDeadline: r.cancelDeadline == null ? null : toDate(r.cancelDeadline),
      publishedAt: r.publishedAt == null ? null : toDate(r.publishedAt),
      prices: pricesByOffering.get(String(r.id)) ?? [],
    };
  });
}

export async function getOfferingById(target: Db | Tx, id: string): Promise<OfferingRow | null> {
  const rows = await queryOfferings(target, { id });
  return rows[0] ?? null;
}

/** قفل ردیف وعده برای تراکنش رزرو (SELECT ... FOR UPDATE). */
export async function lockOfferingForUpdate(
  target: Tx,
  id: string,
): Promise<{
  id: string;
  status: string;
  capacity: number;
  reservedCount: number;
  serviceDate: string;
  mealSlotId: string;
  cafeteriaId: string;
  reserveOpensAt: Date;
  reserveDeadline: Date;
  cancelDeadline: Date | null;
} | null> {
  const result = await target.execute(
    rawSql(
      `SELECT o.id, o.status, o.capacity, o.reserved_count AS "reservedCount", o.service_date AS "serviceDate",
              o.meal_slot_id AS "mealSlotId", o.cafeteria_id AS "cafeteriaId",
              o.reserve_opens_at AS "reserveOpensAt", o.reserve_deadline AS "reserveDeadline", o.cancel_deadline AS "cancelDeadline"
       FROM meal_offerings o WHERE o.id = $1 AND o.deleted_at IS NULL FOR UPDATE`,
      [id],
    ),
  );
  const row = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status),
    capacity: Number(row.capacity),
    reservedCount: Number(row.reservedCount),
    serviceDate: String(row.serviceDate).slice(0, 10),
    mealSlotId: String(row.mealSlotId),
    cafeteriaId: String(row.cafeteriaId),
    reserveOpensAt: toDate(row.reserveOpensAt),
    reserveDeadline: toDate(row.reserveDeadline),
    cancelDeadline: row.cancelDeadline == null ? null : toDate(row.cancelDeadline),
  };
}

/** قیمت یک وعده برای یک گروه مشتری؛ نبودِ ردیف ⇒ آن گروه این وعده را نمی‌بیند. */
export async function priceForGroup(target: Db | Tx, offeringId: string, customerGroup: string): Promise<number | null> {
  const result = await target.execute(
    rawSql(`SELECT price_rial::text AS price FROM offering_prices WHERE offering_id = $1 AND customer_group = $2`, [
      offeringId,
      customerGroup,
    ]),
  );
  const row = ((result as unknown as { rows: { price: string }[] }).rows ?? [])[0];
  return row ? Number(row.price) : null;
}

function placeholder(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
