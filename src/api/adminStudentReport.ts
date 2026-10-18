import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Full per-student report: profile, wallet, reservations, deliveries and ledger',
  inputSchema: z.object({ token: z.string(), studentId: z.string().uuid() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token);
    if (!['SuperAdmin', 'StudentAffairs', 'Finance'].includes(staff.role)) fail('FORBIDDEN', 'شما مجوز مشاهده‌ی گزارش دانشجو را ندارید.');
    const p = [input.studentId];
    const [prof, res, ledger] = await Promise.all([
      zite.sql({ query: `SELECT s.*, b."fileName" AS "batchName" FROM "Students" s LEFT JOIN "ImportBatches" b ON b.id::text = s."lastImportBatch" WHERE s.id = $1`, params: p }),
      zite.sql({
        query: `SELECT r.id, r."code", r."status", r."priceAtBooking", r."createdAt", o."serviceDate", o."mealType",
          (SELECT f."name" FROM "FoodsMealOfferings" fo JOIN "Foods" f ON f.id=fo."foodsId" WHERE fo."mealOfferingsId"=o.id LIMIT 1) AS food,
          (SELECT c."name" FROM "CafeteriasMealOfferings" co JOIN "Cafeterias" c ON c.id=co."cafeteriasId" WHERE co."mealOfferingsId"=o.id LIMIT 1) AS cafeteria,
          (SELECT d."createdAt" FROM "DeliveriesReservations" dr JOIN "Deliveries" d ON d.id=dr."deliveriesId" WHERE dr."reservationsId"=r.id AND d."outcome"='Accepted' LIMIT 1) AS "deliveredAt"
          FROM "ReservationsStudents" rs JOIN "Reservations" r ON r.id=rs."reservationsId"
          LEFT JOIN "MealOfferingsReservations" mo ON mo."reservationsId"=r.id LEFT JOIN "MealOfferings" o ON o.id=mo."mealOfferingsId"
          WHERE rs."studentsId"=$1 ORDER BY o."serviceDate" DESC NULLS LAST, r."createdAt" DESC LIMIT 1000`,
        params: p,
      }),
      zite.sql({ query: `SELECT e."trackingCode", e."type", e."amountRial", e."createdAt" FROM "LedgerEntriesStudents" l JOIN "LedgerEntries" e ON e.id=l."ledgerEntriesId" WHERE l."studentsId"=$1 ORDER BY e."createdAt" DESC LIMIT 1000`, params: p }),
    ]);
    const s = prof.rows[0];
    if (!s) fail('NOT_FOUND', 'دانشجو یافت نشد.');
    const reservations = res.rows.map((r) => ({
      id: String(r.id), code: String(r.code ?? ''), status: String(r.status ?? ''), priceRial: Number(r.priceAtBooking ?? 0), createdAt: r.createdAt ? String(r.createdAt) : null,
      serviceDate: r.serviceDate ? String(r.serviceDate).slice(0, 10) : '', mealType: String(r.mealType ?? ''), food: String(r.food ?? ''), cafeteria: String(r.cafeteria ?? ''), deliveredAt: r.deliveredAt ? String(r.deliveredAt) : null,
    }));
    const entries = ledger.rows.map((e) => ({ trackingCode: String(e.trackingCode ?? ''), type: String(e.type ?? ''), amountRial: Number(e.amountRial ?? 0), createdAt: e.createdAt ? String(e.createdAt) : null }));
    const by = (st: string) => reservations.filter((r) => r.status === st).length;
    const sum = (pred: (a: number) => boolean) => entries.filter((e) => pred(e.amountRial)).reduce((a, e) => a + e.amountRial, 0);
    return {
      profile: {
        id: String(s.id), studentNumber: String(s.studentNumber ?? ''), fullName: String(s.fullName ?? ''), faculty: String(s.faculty ?? ''), major: String(s.major ?? ''),
        degree: String(s.degree ?? ''), entryYear: s.entryYear == null ? null : Number(s.entryYear), status: String(s.status ?? 'Active'),
        nationalIdMasked: `••••••${s.nationalIdLastDigits ?? '••••'}`, addedAt: s.addedAt ? String(s.addedAt) : null, removedAt: s.removedAt ? String(s.removedAt) : null,
        lastImport: s.batchName ? String(s.batchName) : null,
      },
      stats: {
        balanceRial: entries.reduce((a, e) => a + e.amountRial, 0), creditsRial: sum((a) => a > 0), debitsRial: -sum((a) => a < 0),
        total: reservations.length, reserved: by('Reserved'), delivered: by('Delivered'), cancelled: by('Cancelled'), expired: by('Expired'), rejected: by('Rejected'),
        spentRial: reservations.filter((r) => r.status === 'Delivered' || r.status === 'Reserved').reduce((a, r) => a + r.priceRial, 0),
      },
      reservations, ledger: entries,
    };
  },
});
