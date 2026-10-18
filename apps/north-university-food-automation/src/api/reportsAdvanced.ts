import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, requireStaff, tehranToday } from '../server/core';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = (v: unknown) => Number(v ?? 0);

export default createEndpoint({
  description: 'Management analytics: daily trend, finance by type, faculty/major consumption, top foods, wallets and student activity',
  inputSchema: z.object({ token: z.string(), from: day, to: day }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token);
    if (!['SuperAdmin', 'Finance', 'StudentAffairs'].includes(staff.role)) fail('FORBIDDEN', 'شما مجوز مشاهده‌ی گزارش‌های مدیریتی را ندارید.');
    const p = [input.from, input.to];
    const resBase = `FROM "Reservations" r JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=r.id JOIN "MealOfferings" o ON o.id=mr."mealOfferingsId"
      WHERE o."serviceDate" BETWEEN $1::date AND $2::date`;
    const stuJoin = `JOIN "ReservationsStudents" rs ON rs."reservationsId"=r.id JOIN "Students" s ON s.id=rs."studentsId"`;
    const [daily, meals, foods, faculty, major, ledger, ledgerDaily, wallets, students, totals] = await Promise.all([
      zite.sql({ query: `SELECT to_char(o."serviceDate" AT TIME ZONE 'UTC','YYYY-MM-DD') AS d,
          COUNT(*) FILTER (WHERE r.status IN ('Reserved','Delivered')) AS reserved, COUNT(*) FILTER (WHERE r.status='Delivered') AS delivered,
          COUNT(*) FILTER (WHERE r.status='Cancelled') AS cancelled, COUNT(*) FILTER (WHERE r.status IN ('Expired') OR (r.status='Reserved' AND o."serviceDate" < $3::date)) AS "noShow",
          COALESCE(SUM(r."priceAtBooking") FILTER (WHERE r.status IN ('Reserved','Delivered')),0) AS value
        ${resBase} GROUP BY 1 ORDER BY 1`, params: [...p, tehranToday()] }),
      zite.sql({ query: `SELECT o."mealType" AS k, COUNT(*) FILTER (WHERE r.status IN ('Reserved','Delivered')) AS reserved, COUNT(*) FILTER (WHERE r.status='Delivered') AS delivered,
          COALESCE(SUM(r."priceAtBooking") FILTER (WHERE r.status IN ('Reserved','Delivered')),0) AS value ${resBase} GROUP BY 1`, params: p }),
      zite.sql({ query: `SELECT f."name" AS k, COUNT(*) FILTER (WHERE r.status IN ('Reserved','Delivered')) AS reserved, COUNT(*) FILTER (WHERE r.status='Delivered') AS delivered,
          COUNT(*) FILTER (WHERE r.status='Cancelled') AS cancelled, COALESCE(SUM(r."priceAtBooking") FILTER (WHERE r.status IN ('Reserved','Delivered')),0) AS value
          ${resBase.replace('WHERE', `JOIN "FoodsMealOfferings" fo ON fo."mealOfferingsId"=o.id JOIN "Foods" f ON f.id=fo."foodsId" WHERE`)} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, params: p }),
      zite.sql({ query: `SELECT COALESCE(NULLIF(s."faculty",''),'نامشخص') AS k, COUNT(DISTINCT s.id) AS students, COUNT(*) FILTER (WHERE r.status IN ('Reserved','Delivered')) AS reserved,
          COUNT(*) FILTER (WHERE r.status='Delivered') AS delivered, COALESCE(SUM(r."priceAtBooking") FILTER (WHERE r.status IN ('Reserved','Delivered')),0) AS value
          ${resBase.replace('WHERE', `${stuJoin} WHERE`)} GROUP BY 1 ORDER BY 3 DESC LIMIT 30`, params: p }),
      zite.sql({ query: `SELECT COALESCE(NULLIF(s."major",''),'نامشخص') AS k, COUNT(DISTINCT s.id) AS students, COUNT(*) FILTER (WHERE r.status IN ('Reserved','Delivered')) AS reserved,
          COUNT(*) FILTER (WHERE r.status='Delivered') AS delivered, COALESCE(SUM(r."priceAtBooking") FILTER (WHERE r.status IN ('Reserved','Delivered')),0) AS value
          ${resBase.replace('WHERE', `${stuJoin} WHERE`)} GROUP BY 1 ORDER BY 3 DESC LIMIT 30`, params: p }),
      zite.sql({ query: `SELECT e."type" AS k, COUNT(*) AS c, COALESCE(SUM(e."amountRial"),0) AS amount FROM "LedgerEntries" e
          WHERE (e."createdAt" AT TIME ZONE 'Asia/Tehran')::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, params: p }),
      zite.sql({ query: `SELECT to_char((e."createdAt" AT TIME ZONE 'Asia/Tehran')::date,'YYYY-MM-DD') AS d,
          COALESCE(SUM(e."amountRial") FILTER (WHERE e."amountRial">0),0) AS "in", COALESCE(-SUM(e."amountRial") FILTER (WHERE e."amountRial"<0),0) AS "out"
          FROM "LedgerEntries" e WHERE (e."createdAt" AT TIME ZONE 'Asia/Tehran')::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, params: p }),
      zite.sql({ query: `SELECT COUNT(*) AS students, COALESCE(SUM(b),0) AS total, COUNT(*) FILTER (WHERE b>0) AS positive, COUNT(*) FILTER (WHERE b<0) AS negative, COALESCE(MAX(b),0) AS max
          FROM (SELECT s.id, COALESCE((SELECT SUM(e."amountRial") FROM "LedgerEntriesStudents" l JOIN "LedgerEntries" e ON e.id=l."ledgerEntriesId" WHERE l."studentsId"=s.id),0) AS b FROM "Students" s) x` }),
      zite.sql({ query: `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE COALESCE(status,'Active')='Active') AS active, COUNT(*) FILTER (WHERE status='Inactive') AS inactive,
          COUNT(*) FILTER (WHERE status='Removed') AS removed,
          (SELECT COUNT(DISTINCT rs."studentsId") FROM "ReservationsStudents" rs JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=rs."reservationsId" JOIN "MealOfferings" o ON o.id=mr."mealOfferingsId" WHERE o."serviceDate" BETWEEN $1::date AND $2::date) AS engaged
          FROM "Students"`, params: p }),
      zite.sql({ query: `SELECT COUNT(DISTINCT o.id) AS offerings, COALESCE(SUM(DISTINCT o."capacity"),0) AS cap FROM "MealOfferings" o WHERE o."serviceDate" BETWEEN $1::date AND $2::date`, params: p }),
    ]);
    const grp = (rows: Record<string, unknown>[]) => rows.map((x) => ({ key: String(x.k ?? ''), students: n(x.students), reserved: n(x.reserved), delivered: n(x.delivered), cancelled: n(x.cancelled), valueRial: n(x.value) }));
    const w = wallets.rows[0] ?? {}, s = students.rows[0] ?? {};
    return {
      daily: daily.rows.map((x) => ({ date: String(x.d), reserved: n(x.reserved), delivered: n(x.delivered), cancelled: n(x.cancelled), noShow: n(x.noShow), valueRial: n(x.value) })),
      meals: grp(meals.rows), foods: grp(foods.rows), faculty: grp(faculty.rows), major: grp(major.rows),
      ledger: ledger.rows.map((x) => ({ type: String(x.k ?? ''), count: n(x.c), amountRial: n(x.amount) })),
      ledgerDaily: ledgerDaily.rows.map((x) => ({ date: String(x.d), inRial: n(x.in), outRial: n(x.out) })),
      wallets: { students: n(w.students), totalRial: n(w.total), positive: n(w.positive), negative: n(w.negative), maxRial: n(w.max) },
      students: { total: n(s.total), active: n(s.active), inactive: n(s.inactive), removed: n(s.removed), engaged: n(s.engaged) },
      offerings: n(totals.rows[0]?.offerings),
    };
  },
});
