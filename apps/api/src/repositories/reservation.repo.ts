import type { Db, Tx } from '../db/client.js';
import { rawSql } from '../db/raw.js';

/** لایهٔ repository برای رزروها (فقط پرس‌وجو؛ منطق کسب‌وکار در سرویس است). */

export type ReservationRow = {
  id: string;
  code: string;
  status: string;
  priceRial: number;
  createdAt: Date;
  serviceDate: string;
  mealSlot: string;
  mealSlotTitle: string;
  slotStartTime: string;
  slotEndTime: string;
  foodName: string;
  foodId: string;
  offeringId: string;
  offeringStatus: string;
  cafeteriaId: string;
  cafeteriaName: string;
  offeringCancelDeadline: Date | null;
  accountId: string;
  customerGroup: string;
  holderId: string;
  holderIdentifier: string;
  holderName: string;
  holderKind: 'Student' | 'Employee';
  deliveredAt: Date | null;
  deliveredBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  qrToken: string | null;
};

export type ReservationFilters = {
  accountId?: string;
  offeringId?: string;
  status?: string;
  statuses?: string[];
  from?: string;
  to?: string;
  cafeteriaId?: string;
  customerGroup?: string;
  search?: string;
  ids?: string[];
  offset?: number;
  limit?: number;
};

export async function queryReservations(
  target: Db | Tx,
  filters: ReservationFilters = {},
): Promise<{ rows: ReservationRow[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.accountId) where.push(`r.account_id = ${p(filters.accountId)}::uuid`);
  if (filters.offeringId) where.push(`r.offering_id = ${p(filters.offeringId)}::uuid`);
  if (filters.status) where.push(`r.status = ${p(filters.status)}`);
  if (filters.statuses?.length) where.push(`r.status = ANY(${p(filters.statuses)})`);
  if (filters.from) where.push(`r.service_date >= ${p(filters.from)}::date`);
  if (filters.to) where.push(`r.service_date <= ${p(filters.to)}::date`);
  if (filters.cafeteriaId) where.push(`r.cafeteria_id = ${p(filters.cafeteriaId)}::uuid`);
  if (filters.customerGroup) where.push(`a.customer_group = ${p(filters.customerGroup)}`);
  if (filters.ids?.length) where.push(`r.id = ANY(${p(filters.ids)}::uuid[])`);
  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    where.push(
      `(r.code ILIKE ${p(like)} OR s.student_number ILIKE ${p(like)} OR s.full_name ILIKE ${p(like)} OR e.username ILIKE ${p(like)} OR e.full_name ILIKE ${p(like)})`,
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await target.execute(
    rawSql(
      `SELECT r.id, r.code, r.status, r.price_at_booking::text AS "priceRial", r.created_at AS "createdAt",
              r.service_date AS "serviceDate", r.delivered_at AS "deliveredAt", r.delivered_by AS "deliveredBy",
              r.cancelled_at AS "cancelledAt", r.cancel_reason AS "cancelReason", r.qr_token AS "qrToken",
              ms.code AS "mealSlot", ms.title AS "mealSlotTitle", ms.start_time AS "slotStartTime", ms.end_time AS "slotEndTime",
              f.id AS "foodId", f.name AS "foodName",
              o.id AS "offeringId", o.status AS "offeringStatus", o.cancel_deadline AS "offeringCancelDeadline",
              c.id AS "cafeteriaId", c.name AS "cafeteriaName",
              a.id AS "accountId", a.customer_group AS "customerGroup", a.kind AS "holderKind",
              COALESCE(s.id, e.id) AS "holderId",
              COALESCE(s.student_number, e.username) AS "holderIdentifier",
              COALESCE(s.full_name, e.full_name) AS "holderName"
       FROM reservations r
       JOIN meal_offerings o ON o.id = r.offering_id
       JOIN meal_slots ms ON ms.id = r.meal_slot_id
       JOIN foods f ON f.id = o.food_id
       JOIN cafeterias c ON c.id = r.cafeteria_id
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       ${whereSql}
       ORDER BY r.service_date DESC, r.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );

  const countResult = await target.execute(
    rawSql(
      `SELECT COUNT(*)::int AS n
       FROM reservations r
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       ${whereSql}`,
      params,
    ),
  );

  const rows = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  const total = Number(((countResult as unknown as { rows: { n: number }[] }).rows ?? [])[0]?.n ?? rows.length);

  return {
    rows: rows.map((r) => ({
      id: String(r.id),
      code: String(r.code ?? ''),
      status: String(r.status ?? ''),
      priceRial: Number(r.priceRial ?? 0),
      createdAt: toDate(r.createdAt),
      serviceDate: String(r.serviceDate ?? '').slice(0, 10),
      mealSlot: String(r.mealSlot ?? ''),
      mealSlotTitle: String(r.mealSlotTitle ?? ''),
      slotStartTime: String(r.slotStartTime ?? ''),
      slotEndTime: String(r.slotEndTime ?? ''),
      foodName: String(r.foodName ?? ''),
      foodId: String(r.foodId ?? ''),
      offeringId: String(r.offeringId ?? ''),
      offeringStatus: String(r.offeringStatus ?? ''),
      cafeteriaId: String(r.cafeteriaId ?? ''),
      cafeteriaName: String(r.cafeteriaName ?? ''),
      offeringCancelDeadline: r.offeringCancelDeadline == null ? null : toDate(r.offeringCancelDeadline),
      accountId: String(r.accountId ?? ''),
      customerGroup: String(r.customerGroup ?? ''),
      holderId: String(r.holderId ?? ''),
      holderIdentifier: String(r.holderIdentifier ?? ''),
      holderName: String(r.holderName ?? ''),
      holderKind: String(r.holderKind) === 'Employee' ? 'Employee' : 'Student',
      deliveredAt: r.deliveredAt == null ? null : toDate(r.deliveredAt),
      deliveredBy: r.deliveredBy == null ? null : String(r.deliveredBy),
      cancelledAt: r.cancelledAt == null ? null : toDate(r.cancelledAt),
      cancelReason: r.cancelReason == null ? null : String(r.cancelReason),
      qrToken: r.qrToken == null ? null : String(r.qrToken),
    })),
    total,
  };
}

/** خواندن یک رزرو با قفل ردیف (برای لغو/تحویل اتمیک). */
export async function lockReservationForUpdate(target: Tx, id: string): Promise<ReservationRow | null> {
  const result = await target.execute(
    rawSql(
      `SELECT r.id, r.code, r.status, r.price_at_booking::text AS "priceRial", r.created_at AS "createdAt",
              r.service_date AS "serviceDate", r.delivered_at AS "deliveredAt", r.delivered_by AS "deliveredBy",
              r.cancelled_at AS "cancelledAt", r.cancel_reason AS "cancelReason", r.qr_token AS "qrToken",
              r.account_id AS "accountId", r.offering_id AS "offeringId",
              ms.code AS "mealSlot", ms.title AS "mealSlotTitle", ms.start_time AS "slotStartTime", ms.end_time AS "slotEndTime",
              f.name AS "foodName", c.name AS "cafeteriaName", a.customer_group AS "customerGroup"
       FROM reservations r
       JOIN meal_offerings mo ON mo.id = r.offering_id
       JOIN meal_slots ms ON ms.id = r.meal_slot_id
       JOIN foods f ON f.id = mo.food_id
       JOIN cafeterias c ON c.id = r.cafeteria_id
       JOIN accounts a ON a.id = r.account_id
       WHERE r.id = $1 FOR UPDATE OF r`,
      [id],
    ),
  );
  const row = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code ?? ''),
    status: String(row.status ?? ''),
    priceRial: Number(row.priceRial ?? 0),
    createdAt: toDate(row.createdAt),
    serviceDate: String(row.serviceDate ?? '').slice(0, 10),
    mealSlot: String(row.mealSlot ?? ''),
    mealSlotTitle: String(row.mealSlotTitle ?? ''),
    slotStartTime: String(row.slotStartTime ?? ''),
    slotEndTime: String(row.slotEndTime ?? ''),
    foodName: String(row.foodName ?? ''),
    foodId: '',
    offeringId: String(row.offeringId ?? ''),
    offeringStatus: '',
    cafeteriaId: '',
    cafeteriaName: String(row.cafeteriaName ?? ''),
    offeringCancelDeadline: null,
    accountId: String(row.accountId ?? ''),
    customerGroup: String(row.customerGroup ?? ''),
    holderId: '',
    holderIdentifier: '',
    holderName: '',
    holderKind: 'Student',
    deliveredAt: row.deliveredAt == null ? null : toDate(row.deliveredAt),
    deliveredBy: row.deliveredBy == null ? null : String(row.deliveredBy),
    cancelledAt: row.cancelledAt == null ? null : toDate(row.cancelledAt),
    cancelReason: row.cancelReason == null ? null : String(row.cancelReason),
    qrToken: row.qrToken == null ? null : String(row.qrToken),
  };
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
