import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStaff, tehranToday } from '../server/core';

export default createEndpoint({
  description: 'Management dashboard KPIs computed from live data',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'dashboard');
    const today = tehranToday();
    const showMoney = staff.role === 'SuperAdmin' || staff.role === 'Finance';
    const [students, todayStats, trend, byMeal, lastImport, ledger] = await Promise.all([
      zite.sql({ query: `SELECT COUNT(*) FILTER (WHERE "status"='Active') AS active, COUNT(*) AS total FROM "Students"` }),
      zite.sql({
        query: `SELECT COALESCE(SUM(o."capacity"),0) AS capacity,
          (SELECT COUNT(*) FROM "Reservations" r JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=r.id JOIN "MealOfferings" o2 ON o2.id=mr."mealOfferingsId" WHERE o2."serviceDate"=$1::date AND r."status" IN ('Reserved','Delivered')) AS reserved,
          (SELECT COUNT(*) FROM "Reservations" r JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=r.id JOIN "MealOfferings" o2 ON o2.id=mr."mealOfferingsId" WHERE o2."serviceDate"=$1::date AND r."status"='Delivered') AS delivered,
          (SELECT COUNT(*) FROM "Reservations" r JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=r.id JOIN "MealOfferings" o2 ON o2.id=mr."mealOfferingsId" WHERE o2."serviceDate"=$1::date AND r."status"='Cancelled') AS cancelled
          FROM "MealOfferings" o WHERE o."serviceDate"=$1::date AND o."active"=true`,
        params: [today],
      }),
      zite.sql({
        query: `SELECT to_char(o."serviceDate" AT TIME ZONE 'UTC','YYYY-MM-DD') AS d,
          COUNT(r.id) FILTER (WHERE r."status" IN ('Reserved','Delivered')) AS reserved,
          COUNT(r.id) FILTER (WHERE r."status"='Delivered') AS delivered,
          COUNT(r.id) FILTER (WHERE r."status"='Reserved' AND o."serviceDate" < $1::date) AS "noShow"
          FROM "MealOfferings" o LEFT JOIN "MealOfferingsReservations" mr ON mr."mealOfferingsId"=o.id LEFT JOIN "Reservations" r ON r.id=mr."reservationsId"
          WHERE o."serviceDate" BETWEEN ($1::date - 13) AND ($1::date + 7) GROUP BY 1 ORDER BY 1`,
        params: [today],
      }),
      zite.sql({
        query: `SELECT o."mealType" AS meal, COALESCE(SUM(o."capacity"),0) AS capacity,
          (SELECT COUNT(*) FROM "Reservations" r JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=r.id JOIN "MealOfferings" o2 ON o2.id=mr."mealOfferingsId" WHERE o2."serviceDate"=$1::date AND o2."mealType"=o."mealType" AND r."status" IN ('Reserved','Delivered')) AS reserved
          FROM "MealOfferings" o WHERE o."serviceDate"=$1::date AND o."active"=true GROUP BY o."mealType"`,
        params: [today],
      }),
      zite.sql({ query: `SELECT "fileName", "status", "totalRows", "validRows", "errorRows", created_at AS "createdAt" FROM "ImportBatches" ORDER BY created_at DESC LIMIT 1` }),
      showMoney
        ? zite.sql({ query: `SELECT COALESCE(SUM("amountRial") FILTER (WHERE "type"='ManualCredit'),0) AS credits, COALESCE(-SUM("amountRial") FILTER (WHERE "type"='ReservationDebit'),0) AS debits, COALESCE(SUM("amountRial") FILTER (WHERE "type" IN ('CancellationRefund','CapacityRefund')),0) AS refunds, COALESCE(SUM("amountRial"),0) AS liability FROM "LedgerEntries"` })
        : Promise.resolve(null),
    ]);
    const t = todayStats.rows[0] ?? {};
    return {
      today,
      activeStudents: Number(students.rows[0]?.active ?? 0),
      totalStudents: Number(students.rows[0]?.total ?? 0),
      todayCapacity: Number(t.capacity ?? 0), todayReserved: Number(t.reserved ?? 0), todayDelivered: Number(t.delivered ?? 0), todayCancelled: Number(t.cancelled ?? 0),
      trend: trend.rows.map((r) => ({ date: String(r.d), reserved: Number(r.reserved), delivered: Number(r.delivered), noShow: Number(r.noShow) })),
      byMeal: byMeal.rows.map((r) => ({ meal: String(r.meal), capacity: Number(r.capacity), reserved: Number(r.reserved) })),
      lastImport: lastImport.rows[0] ? { fileName: String(lastImport.rows[0].fileName ?? ''), status: String(lastImport.rows[0].status ?? ''), totalRows: Number(lastImport.rows[0].totalRows ?? 0), validRows: Number(lastImport.rows[0].validRows ?? 0), errorRows: Number(lastImport.rows[0].errorRows ?? 0), createdAt: String(lastImport.rows[0].createdAt ?? '') } : null,
      money: ledger ? { credits: Number(ledger.rows[0]?.credits ?? 0), debits: Number(ledger.rows[0]?.debits ?? 0), refunds: Number(ledger.rows[0]?.refunds ?? 0), liability: Number(ledger.rows[0]?.liability ?? 0) } : null,
    };
  },
});
