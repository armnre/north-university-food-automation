import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Lists ledger entries for finance review with filters and a reconciliation check',
  inputSchema: z.object({ token: z.string(), type: z.string().optional(), search: z.string().max(80).optional(), from: z.string().optional(), to: z.string().optional(), offset: z.number().int().min(0).default(0) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    await requireStaff(input.token, 'finance');
    const params: unknown[] = [];
    const where: string[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (input.type) where.push(`e."type" = ${p(input.type)}`);
    if (input.from) where.push(`e.created_at >= (${p(input.from)}::date)::timestamp AT TIME ZONE 'Asia/Tehran'`);
    if (input.to) where.push(`e.created_at < ((${p(input.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Tehran')`);
    if (input.search) where.push(`(s."studentNumber" ILIKE ${p('%' + input.search + '%')} OR e."trackingCode" ILIKE $${params.length})`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, totals, recon] = await Promise.all([
      zite.sql({
        query: `SELECT e.id, e."trackingCode", e."type", e."amountRial", e."counterAccount", e."reason", e.created_at AS "createdAt", s."studentNumber", s."fullName",
          (SELECT u."fullName" FROM "LedgerEntriesStaffUsers" lu JOIN "StaffUsers" u ON u.id=lu."staffUsersId" WHERE lu."ledgerEntriesId"=e.id LIMIT 1) AS actor,
          (SELECT r."code" FROM "LedgerEntriesReservations" lr JOIN "Reservations" r ON r.id=lr."reservationsId" WHERE lr."ledgerEntriesId"=e.id LIMIT 1) AS "reservationCode"
          FROM "LedgerEntries" e LEFT JOIN "LedgerEntriesStudents" l ON l."ledgerEntriesId"=e.id LEFT JOIN "Students" s ON s.id=l."studentsId"
          ${w} ORDER BY e."seq" DESC LIMIT 100 OFFSET ${input.offset}`,
        params,
      }),
      zite.sql({ query: `SELECT e."type", COUNT(*) AS n, COALESCE(SUM(e."amountRial"),0) AS total FROM "LedgerEntries" e LEFT JOIN "LedgerEntriesStudents" l ON l."ledgerEntriesId"=e.id LEFT JOIN "Students" s ON s.id=l."studentsId" ${w} GROUP BY e."type"`, params }),
      // Reconciliation: every Reserved/Delivered reservation must have a debit equal to its booked price,
      // and every Cancelled/Rejected one with price>0 must net to zero.
      zite.sql({
        query: `SELECT r."code", r."status", r."priceAtBooking", COALESCE(SUM(e."amountRial"),0) AS net
          FROM "Reservations" r LEFT JOIN "LedgerEntriesReservations" lr ON lr."reservationsId"=r.id LEFT JOIN "LedgerEntries" e ON e.id=lr."ledgerEntriesId"
          GROUP BY r.id
          HAVING (r."status" IN ('Reserved','Delivered') AND COALESCE(SUM(e."amountRial"),0) <> -r."priceAtBooking")
              OR (r."status" IN ('Cancelled','Rejected') AND COALESCE(SUM(e."amountRial"),0) <> 0)
          LIMIT 50`,
      }),
    ]);
    return {
      entries: rows.rows.map((x) => ({
        id: String(x.id), trackingCode: String(x.trackingCode ?? ''), type: String(x.type ?? ''), amountRial: Number(x.amountRial ?? 0), counterAccount: String(x.counterAccount ?? ''),
        reason: String(x.reason ?? ''), createdAt: String(x.createdAt ?? ''), studentNumber: String(x.studentNumber ?? ''), studentName: String(x.fullName ?? ''),
        actor: x.actor ? String(x.actor) : null, reservationCode: x.reservationCode ? String(x.reservationCode) : null,
      })),
      totals: totals.rows.map((x) => ({ type: String(x.type), count: Number(x.n), total: Number(x.total) })),
      mismatches: recon.rows.map((x) => ({ code: String(x.code ?? ''), status: String(x.status ?? ''), priceAtBooking: Number(x.priceAtBooking ?? 0), net: Number(x.net ?? 0) })),
      hasMore: rows.rows.length === 100,
    };
  },
});
