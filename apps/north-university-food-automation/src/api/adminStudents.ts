import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Searches and categorises students with facet counts (national id is never returned)',
  inputSchema: z.object({
    token: z.string(),
    search: z.string().max(100).optional(),
    status: z.enum(['Active', 'Inactive', 'Removed']).optional(),
    faculty: z.string().max(200).optional(),
    major: z.string().max(200).optional(),
    degree: z.string().max(100).optional(),
    entryYear: z.number().int().optional(),
    sort: z.enum(['studentNumber', 'fullName', 'balance', 'reservations', 'addedAt', 'removedAt']).default('studentNumber'),
    dir: z.enum(['asc', 'desc']).default('asc'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(50),
  }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token);
    if (!['SuperAdmin', 'StudentAffairs', 'Finance'].includes(staff.role)) fail('FORBIDDEN', 'شما مجوز مشاهده‌ی فهرست دانشجویان را ندارید.');
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (input.search) add(`(s."studentNumber" ILIKE ? OR s."fullName" ILIKE $${params.length + 1} OR s."major" ILIKE $${params.length + 1})`, `%${input.search.trim()}%`);
    if (input.status) add(`COALESCE(s."status",'Active') = ?`, input.status);
    if (input.faculty) add(`COALESCE(s."faculty",'') = ?`, input.faculty);
    if (input.major) add(`COALESCE(s."major",'') = ?`, input.major);
    if (input.degree) add(`COALESCE(s."degree",'') = ?`, input.degree);
    if (input.entryYear) add(`s."entryYear" = ?`, input.entryYear);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = { studentNumber: 's."studentNumber"', fullName: 's."fullName"', balance: 'balance', reservations: 'reservations', addedAt: 's."addedAt"', removedAt: 's."removedAt"' }[input.sort];
    const facet = (col: string) => zite.sql({ query: `SELECT COALESCE(s.${col}::text,'') AS v, COUNT(*) AS n FROM "Students" s ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 100`, params });
    const [rows, count, st, fac, maj, deg, yr] = await Promise.all([
      zite.sql({
        query: `SELECT * FROM (SELECT s.id, s."studentNumber", s."fullName", s."faculty", s."major", s."degree", s."entryYear", s."status", s."nationalIdLastDigits", s."addedAt", s."removedAt",
          (SELECT COALESCE(SUM(e."amountRial"),0) FROM "LedgerEntriesStudents" l JOIN "LedgerEntries" e ON e.id=l."ledgerEntriesId" WHERE l."studentsId"=s.id) AS balance,
          (SELECT COUNT(*) FROM "ReservationsStudents" rs JOIN "Reservations" r ON r.id=rs."reservationsId" WHERE rs."studentsId"=s.id AND r."status" IN ('Reserved','Delivered')) AS reservations
          FROM "Students" s ${w}) s ORDER BY ${order} ${input.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST LIMIT ${input.limit} OFFSET ${input.offset}`,
        params,
      }),
      zite.sql({ query: `SELECT COUNT(*) AS n FROM "Students" s ${w}`, params }),
      facet(`"status"`), facet(`"faculty"`), facet(`"major"`), facet(`"degree"`), facet(`"entryYear"`),
    ]);
    const f = (r: { rows: Record<string, unknown>[] }) => r.rows.map((x) => ({ value: String(x.v ?? ''), count: Number(x.n ?? 0) }));
    return {
      total: Number(count.rows[0]?.n ?? 0),
      facets: { status: f(st), faculty: f(fac), major: f(maj), degree: f(deg), entryYear: f(yr) },
      students: rows.rows.map((r) => ({
        id: String(r.id), studentNumber: String(r.studentNumber ?? ''), fullName: String(r.fullName ?? ''), faculty: String(r.faculty ?? ''),
        major: String(r.major ?? ''), degree: String(r.degree ?? ''), entryYear: r.entryYear == null ? null : Number(r.entryYear),
        status: String(r.status ?? 'Active'), nationalIdMasked: `••••••${r.nationalIdLastDigits ?? '••••'}`, balanceRial: Number(r.balance ?? 0),
        reservations: Number(r.reservations ?? 0), addedAt: r.addedAt ? String(r.addedAt) : null, removedAt: r.removedAt ? String(r.removedAt) : null,
      })),
    };
  },
});
