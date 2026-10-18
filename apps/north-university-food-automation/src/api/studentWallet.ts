import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStudent } from '../server/core';

export default createEndpoint({
  description: 'Returns the student’s ledger-derived wallet balance and transaction history',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const r = await zite.sql({
      query: `SELECT e.id, e."trackingCode", e."type", e."amountRial", e."reason", e.created_at AS "createdAt",
          SUM(e."amountRial") OVER (ORDER BY e."seq" ASC) AS "runningBalance"
        FROM "LedgerEntries" e JOIN "LedgerEntriesStudents" l ON l."ledgerEntriesId" = e.id
        WHERE l."studentsId" = $1 ORDER BY e."seq" DESC LIMIT 500`,
      params: [student.id],
    });
    const tx = r.rows.map((x) => ({
      id: String(x.id), trackingCode: String(x.trackingCode ?? ''), type: String(x.type ?? ''), amountRial: Number(x.amountRial ?? 0),
      reason: String(x.reason ?? ''), createdAt: String(x.createdAt ?? ''), runningBalance: Number(x.runningBalance ?? 0),
    }));
    return { balanceRial: tx[0]?.runningBalance ?? 0, transactions: tx };
  },
});
