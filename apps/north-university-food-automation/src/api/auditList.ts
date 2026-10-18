import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStaff } from '../server/core';

export default createEndpoint({
  description: 'Lists audit log events (append-only) with search',
  inputSchema: z.object({ token: z.string(), search: z.string().max(80).optional(), offset: z.number().int().min(0).default(0) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    await requireStaff(input.token, 'audit');
    const params: unknown[] = [];
    let w = '';
    if (input.search) { params.push(`%${input.search}%`); w = `WHERE "action" ILIKE $1 OR "actorLabel" ILIKE $1 OR "targetType" ILIKE $1`; }
    const r = await zite.sql({ query: `SELECT id, "action", "actorType", "actorLabel", "targetType", "targetId", "details", created_at AS "createdAt" FROM "AuditLogs" ${w} ORDER BY created_at DESC LIMIT 100 OFFSET ${input.offset}`, params });
    return {
      logs: r.rows.map((x) => ({ id: String(x.id), action: String(x.action ?? ''), actorType: String(x.actorType ?? ''), actorLabel: String(x.actorLabel ?? ''), targetType: String(x.targetType ?? ''), targetId: String(x.targetId ?? ''), details: String(x.details ?? ''), createdAt: String(x.createdAt ?? '') })),
      hasMore: r.rows.length === 100,
    };
  },
});
