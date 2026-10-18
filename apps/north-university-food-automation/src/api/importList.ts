import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Lists past student import batches with their results',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    await requireStaff(input.token, 'import');
    const r = await zite.sql({
      query: `SELECT b.id, b."fileName", b."status", b."policy", b."totalRows", b."validRows", b."errorRows", b."newRows", b."changedRows", b."errorReport", b.created_at AS "createdAt",
        (SELECT u."fullName" FROM "ImportBatchesStaffUsers" l JOIN "StaffUsers" u ON u.id=l."staffUsersId" WHERE l."importBatchesId"=b.id LIMIT 1) AS "uploadedBy"
        FROM "ImportBatches" b ORDER BY b.created_at DESC LIMIT 100`,
    });
    return {
      batches: r.rows.map((x) => ({
        id: String(x.id), fileName: String(x.fileName ?? ''), status: String(x.status ?? ''), policy: String(x.policy ?? ''), totalRows: Number(x.totalRows ?? 0),
        validRows: Number(x.validRows ?? 0), errorRows: Number(x.errorRows ?? 0), newRows: Number(x.newRows ?? 0), changedRows: Number(x.changedRows ?? 0),
        errorReport: String(x.errorReport ?? '[]'), createdAt: String(x.createdAt ?? ''), uploadedBy: String(x.uploadedBy ?? ''),
      })),
    };
  },
});
