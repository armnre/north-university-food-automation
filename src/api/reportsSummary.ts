import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, first, requireStaff, tehranToday } from '../server/core';

/** Operational + financial report per offering. Contractors are automatically scoped to their own cafeterias. */
export default createEndpoint({
  description: 'Per-meal report of reservations, deliveries, no-shows and value with date/cafeteria/meal filters',
  inputSchema: z.object({ token: z.string(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), cafeteriaId: z.string().uuid().optional(), mealType: z.string().optional() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token);
    if (!['SuperAdmin', 'Finance', 'Contractor'].includes(staff.role)) fail('FORBIDDEN', 'شما مجوز مشاهده‌ی گزارش‌ها را ندارید.');
    const params: unknown[] = [input.from, input.to, tehranToday()];
    const where = [`o."serviceDate" BETWEEN $1::date AND $2::date`];
    if (input.cafeteriaId) { params.push(input.cafeteriaId); where.push(`c.id = $${params.length}`); }
    if (input.mealType) { params.push(input.mealType); where.push(`o."mealType" = $${params.length}`); }
    if (staff.role === 'Contractor') {
      const contractorId = first(staff.contractor);
      if (!contractorId) fail('FORBIDDEN', 'حساب پیمانکار به قراردادی متصل نیست.');
      params.push(contractorId);
      where.push(`EXISTS (SELECT 1 FROM "CafeteriasContractors" cc WHERE cc."cafeteriasId" = c.id AND cc."contractorsId" = $${params.length})`);
    }
    const r = await zite.sql({
      query: `SELECT o.id, to_char(o."serviceDate" AT TIME ZONE 'UTC','YYYY-MM-DD') AS date, o."mealType" AS meal, c."name" AS cafeteria, MAX(fd."name") AS food, o."capacity",
          COUNT(r.id) FILTER (WHERE r."status" IN ('Reserved','Delivered')) AS reserved,
          COUNT(r.id) FILTER (WHERE r."status"='Delivered') AS delivered,
          COUNT(r.id) FILTER (WHERE r."status"='Cancelled') AS cancelled,
          COUNT(r.id) FILTER (WHERE r."status"='Reserved' AND o."serviceDate" < $3::date) AS "noShow",
          COALESCE(SUM(r."priceAtBooking") FILTER (WHERE r."status" IN ('Reserved','Delivered')),0) AS value
        FROM "MealOfferings" o
        LEFT JOIN "CafeteriasMealOfferings" cl ON cl."mealOfferingsId"=o.id LEFT JOIN "Cafeterias" c ON c.id=cl."cafeteriasId"
        LEFT JOIN "FoodsMealOfferings" fl ON fl."mealOfferingsId"=o.id LEFT JOIN "Foods" fd ON fd.id=fl."foodsId"
        LEFT JOIN "MealOfferingsReservations" mr ON mr."mealOfferingsId"=o.id LEFT JOIN "Reservations" r ON r.id=mr."reservationsId"
        WHERE ${where.join(' AND ')}
        GROUP BY o.id, c."name" ORDER BY o."serviceDate", o."mealType" LIMIT 2000`,
      params,
    });
    const rows = r.rows.map((x) => ({
      id: String(x.id), date: String(x.date), meal: String(x.meal ?? ''), cafeteria: String(x.cafeteria ?? ''), food: String(x.food ?? ''), capacity: Number(x.capacity ?? 0),
      reserved: Number(x.reserved), delivered: Number(x.delivered), cancelled: Number(x.cancelled), noShow: Number(x.noShow), valueRial: Number(x.value),
    }));
    const sum = (k: 'reserved' | 'delivered' | 'cancelled' | 'noShow' | 'valueRial' | 'capacity') => rows.reduce((a, b) => a + b[k], 0);
    return { rows, totals: { capacity: sum('capacity'), reserved: sum('reserved'), delivered: sum('delivered'), cancelled: sum('cancelled'), noShow: sum('noShow'), valueRial: sum('valueRial') }, scopedToContractor: staff.role === 'Contractor' };
  },
});
