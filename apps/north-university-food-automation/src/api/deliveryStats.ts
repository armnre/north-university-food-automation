import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { first, requireStaff, tehranToday } from '../server/core';

export default createEndpoint({
  description: 'Today’s delivery stats and recent deliveries for the operator’s cafeteria',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'delivery');
    const cafeteriaId = staff.role === 'Operator' ? first(staff.cafeteria) ?? null : null;
    const today = tehranToday();
    const cafFilter = cafeteriaId ? `AND cl."cafeteriasId" = $2` : '';
    const params = cafeteriaId ? [today, cafeteriaId] : [today];
    const [stats, recent, caf] = await Promise.all([
      zite.sql({
        query: `SELECT o."mealType" AS meal, COUNT(r.id) FILTER (WHERE r."status" IN ('Reserved','Delivered')) AS reserved, COUNT(r.id) FILTER (WHERE r."status"='Delivered') AS delivered
          FROM "MealOfferings" o JOIN "CafeteriasMealOfferings" cl ON cl."mealOfferingsId"=o.id
          LEFT JOIN "MealOfferingsReservations" mr ON mr."mealOfferingsId"=o.id LEFT JOIN "Reservations" r ON r.id=mr."reservationsId"
          WHERE o."serviceDate"=$1::date ${cafFilter} GROUP BY o."mealType"`,
        params,
      }),
      zite.sql({
        query: `SELECT d.created_at AS at, r."code", s."studentNumber", fd."name" AS food, o."mealType" AS meal
          FROM "Deliveries" d JOIN "DeliveriesReservations" dr ON dr."deliveriesId"=d.id JOIN "Reservations" r ON r.id=dr."reservationsId"
          JOIN "ReservationsStudents" rs ON rs."reservationsId"=r.id JOIN "Students" s ON s.id=rs."studentsId"
          JOIN "MealOfferingsReservations" mr ON mr."reservationsId"=r.id JOIN "MealOfferings" o ON o.id=mr."mealOfferingsId"
          JOIN "CafeteriasMealOfferings" cl ON cl."mealOfferingsId"=o.id
          LEFT JOIN "FoodsMealOfferings" fl ON fl."mealOfferingsId"=o.id LEFT JOIN "Foods" fd ON fd.id=fl."foodsId"
          WHERE d."outcome"='Accepted' AND o."serviceDate"=$1::date ${cafFilter} ORDER BY d."seq" DESC LIMIT 20`,
        params,
      }),
      cafeteriaId ? zite.cafeterias.findOne({ id: cafeteriaId, fields: ['name'] }) : Promise.resolve(undefined),
    ]);
    return {
      today, cafeteriaName: caf?.name ?? (cafeteriaId ? '' : 'همه سلف‌ها'),
      byMeal: stats.rows.map((x) => ({ meal: String(x.meal), reserved: Number(x.reserved), delivered: Number(x.delivered) })),
      recent: recent.rows.map((x) => ({ at: String(x.at), code: String(x.code ?? ''), studentNumber: String(x.studentNumber ?? ''), food: String(x.food ?? ''), meal: String(x.meal ?? '') })),
    };
  },
});
