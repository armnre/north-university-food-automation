import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Searches students (national id is never returned)',
  inputSchema: z.object({ token: z.string(), search: z.string().max(100).optional(), status: z.enum(['Active', 'Inactive']).optional(), offset: z.number().int().min(0).default(0) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token);
    if (!['SuperAdmin', 'StudentAffairs', 'Finance'].includes(staff.role)) fail('FORBIDDEN', 'شما مجوز مشاهده‌ی فهرست دانشجویان را ندارید.');
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.search) { params.push(`%${input.search.trim()}%`); where.push(`(s."studentNumber" ILIKE $${params.length} OR s."fullName" ILIKE $${params.length} OR s."major" ILIKE $${params.length})`); }
    if (input.status) { params.push(input.status); where.push(`s."status" = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      zite.sql({
        query: `SELECT s.id, s."studentNumber", s."fullName", s."faculty", s."major", s."degree", s."entryYear", s."status", s."nationalIdLastDigits",
          (SELECT COALESCE(SUM(e."amountRial"),0) FROM "LedgerEntriesStudents" l JOIN "LedgerEntries" e ON e.id=l."ledgerEntriesId" WHERE l."studentsId"=s.id) AS balance
          FROM "Students" s ${w} ORDER BY s."studentNumber" ASC LIMIT 50 OFFSET ${input.offset}`,
        params,
      }),
      zite.sql({ query: `SELECT COUNT(*) AS n FROM "Students" s ${w}`, params }),
    ]);
    return {
      total: Number(count.rows[0]?.n ?? 0),
      students: rows.rows.map((r) => ({
        id: String(r.id), studentNumber: String(r.studentNumber ?? ''), fullName: String(r.fullName ?? ''), faculty: String(r.faculty ?? ''),
        major: String(r.major ?? ''), degree: String(r.degree ?? ''), entryYear: r.entryYear == null ? null : Number(r.entryYear),
        status: String(r.status ?? ''), nationalIdMasked: `••••••${r.nationalIdLastDigits ?? '••••'}`, balanceRial: Number(r.balance ?? 0),
      })),
    };
  },
});
