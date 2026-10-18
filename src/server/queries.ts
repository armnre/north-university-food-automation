import { zite } from 'zitejs/db';

export type OfferingRow = {
  id: string; serviceDate: string; mealType: string; foodId: string; foodName: string; foodDescription: string;
  cafeteriaId: string; cafeteriaName: string; priceRial: number; capacity: number; reserved: number; delivered: number; cancelled: number;
  remaining: number; reserveDeadline: string | null; cancelDeadline: string | null; active: boolean; notes: string;
};

/** Offerings with live counts. Filters are optional; all values are bound as params. */
export async function queryOfferings(f: { from?: string; to?: string; cafeteriaId?: string; cafeteriaIds?: string[]; onlyActive?: boolean; id?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.id) where.push(`o.id = ${p(f.id)}`);
  if (f.from) where.push(`o."serviceDate" >= ${p(f.from)}::date`);
  if (f.to) where.push(`o."serviceDate" <= ${p(f.to)}::date`);
  if (f.cafeteriaId) where.push(`c.id = ${p(f.cafeteriaId)}`);
  if (f.cafeteriaIds) where.push(`c.id = ANY(${p(f.cafeteriaIds)}::uuid[])`);
  if (f.onlyActive) where.push(`o."active" = true`);
  const r = await zite.sql({
    query: `
      SELECT o.id, to_char(o."serviceDate" AT TIME ZONE 'UTC','YYYY-MM-DD') AS "serviceDate", o."mealType", o."priceRial", o."capacity",
        o."reserveDeadline", o."cancelDeadline", o."active", o."notes",
        MAX(fd.id::text) AS "foodId", MAX(fd."name") AS "foodName", MAX(fd."description") AS "foodDescription",
        MAX(c.id::text) AS "cafeteriaId", MAX(c."name") AS "cafeteriaName",
        (SELECT COUNT(*) FROM "MealOfferingsReservations" mr JOIN "Reservations" r ON r.id = mr."reservationsId" WHERE mr."mealOfferingsId" = o.id AND r."status" IN ('Reserved','Delivered')) AS reserved,
        (SELECT COUNT(*) FROM "MealOfferingsReservations" mr JOIN "Reservations" r ON r.id = mr."reservationsId" WHERE mr."mealOfferingsId" = o.id AND r."status" = 'Delivered') AS delivered,
        (SELECT COUNT(*) FROM "MealOfferingsReservations" mr JOIN "Reservations" r ON r.id = mr."reservationsId" WHERE mr."mealOfferingsId" = o.id AND r."status" = 'Cancelled') AS cancelled
      FROM "MealOfferings" o
      LEFT JOIN "FoodsMealOfferings" fl ON fl."mealOfferingsId" = o.id
      LEFT JOIN "Foods" fd ON fd.id = fl."foodsId"
      LEFT JOIN "CafeteriasMealOfferings" cl ON cl."mealOfferingsId" = o.id
      LEFT JOIN "Cafeterias" c ON c.id = cl."cafeteriasId"
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY o.id
      ORDER BY o."serviceDate" ASC, o."mealType" ASC
      LIMIT 1000`,
    params,
  });
  return r.rows.map((x): OfferingRow => {
    const capacity = Number(x.capacity ?? 0), reserved = Number(x.reserved ?? 0);
    return {
      id: String(x.id), serviceDate: String(x.serviceDate), mealType: String(x.mealType ?? ''), foodId: String(x.foodId ?? ''),
      foodName: String(x.foodName ?? '—'), foodDescription: String(x.foodDescription ?? ''), cafeteriaId: String(x.cafeteriaId ?? ''),
      cafeteriaName: String(x.cafeteriaName ?? '—'), priceRial: Number(x.priceRial ?? 0), capacity, reserved,
      delivered: Number(x.delivered ?? 0), cancelled: Number(x.cancelled ?? 0), remaining: Math.max(0, capacity - reserved),
      reserveDeadline: x.reserveDeadline ? String(x.reserveDeadline) : null, cancelDeadline: x.cancelDeadline ? String(x.cancelDeadline) : null,
      active: !!x.active, notes: String(x.notes ?? ''),
    };
  });
}

export type ReservationRow = {
  id: string; code: string; status: string; priceAtBooking: number; createdAt: string; offeringId: string; serviceDate: string;
  mealType: string; foodName: string; cafeteriaName: string; cafeteriaId: string; cancelDeadline: string | null;
  studentId: string; studentNumber: string; studentName: string; deliveredAt: string | null;
};

export async function queryReservations(f: { studentId?: string; offeringId?: string; status?: string; from?: string; to?: string; cafeteriaId?: string; search?: string; limit?: number; offset?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.studentId) where.push(`s.id = ${p(f.studentId)}`);
  if (f.offeringId) where.push(`o.id = ${p(f.offeringId)}`);
  if (f.status) where.push(`r."status" = ${p(f.status)}`);
  if (f.from) where.push(`o."serviceDate" >= ${p(f.from)}::date`);
  if (f.to) where.push(`o."serviceDate" <= ${p(f.to)}::date`);
  if (f.cafeteriaId) where.push(`c.id = ${p(f.cafeteriaId)}`);
  if (f.search) where.push(`(s."studentNumber" ILIKE ${p('%' + f.search + '%')} OR s."fullName" ILIKE $${params.length} OR r."code" ILIKE $${params.length})`);
  const r = await zite.sql({
    query: `
      SELECT r.id, r."code", r."status", r."priceAtBooking", r.created_at AS "createdAt",
        o.id AS "offeringId", to_char(o."serviceDate" AT TIME ZONE 'UTC','YYYY-MM-DD') AS "serviceDate", o."mealType", o."cancelDeadline",
        fd."name" AS "foodName", c."name" AS "cafeteriaName", c.id AS "cafeteriaId",
        s.id AS "studentId", s."studentNumber", s."fullName" AS "studentName",
        (SELECT MIN(d.created_at) FROM "DeliveriesReservations" dr JOIN "Deliveries" d ON d.id = dr."deliveriesId" WHERE dr."reservationsId" = r.id AND d."outcome" = 'Accepted') AS "deliveredAt"
      FROM "Reservations" r
      JOIN "ReservationsStudents" rs ON rs."reservationsId" = r.id JOIN "Students" s ON s.id = rs."studentsId"
      JOIN "MealOfferingsReservations" mr ON mr."reservationsId" = r.id JOIN "MealOfferings" o ON o.id = mr."mealOfferingsId"
      LEFT JOIN "FoodsMealOfferings" fl ON fl."mealOfferingsId" = o.id LEFT JOIN "Foods" fd ON fd.id = fl."foodsId"
      LEFT JOIN "CafeteriasMealOfferings" cl ON cl."mealOfferingsId" = o.id LEFT JOIN "Cafeterias" c ON c.id = cl."cafeteriasId"
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o."serviceDate" DESC, r."seq" DESC
      LIMIT ${Math.min(f.limit ?? 200, 500)} OFFSET ${Math.max(0, f.offset ?? 0)}`,
    params,
  });
  return r.rows.map((x): ReservationRow => ({
    id: String(x.id), code: String(x.code ?? ''), status: String(x.status ?? ''), priceAtBooking: Number(x.priceAtBooking ?? 0),
    createdAt: String(x.createdAt ?? ''), offeringId: String(x.offeringId), serviceDate: String(x.serviceDate), mealType: String(x.mealType ?? ''),
    foodName: String(x.foodName ?? '—'), cafeteriaName: String(x.cafeteriaName ?? '—'), cafeteriaId: String(x.cafeteriaId ?? ''),
    cancelDeadline: x.cancelDeadline ? String(x.cancelDeadline) : null, studentId: String(x.studentId), studentNumber: String(x.studentNumber ?? ''),
    studentName: String(x.studentName ?? ''), deliveredAt: x.deliveredAt ? String(x.deliveredAt) : null,
  }));
}

/** A reservation still "Reserved" after its service date is shown as Expired (never deliverable). */
export function effectiveStatus(status: string, serviceDate: string, today: string) {
  return status === 'Reserved' && serviceDate < today ? 'Expired' : status;
}
