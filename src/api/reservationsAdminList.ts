import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { requireStaff, tehranToday } from '../server/core';
import { effectiveStatus, queryReservations } from '../server/queries';

export default createEndpoint({
  description: 'Searches reservations for management with date, cafeteria and status filters',
  inputSchema: z.object({
    token: z.string(), from: z.string().optional(), to: z.string().optional(), cafeteriaId: z.string().uuid().optional(),
    offeringId: z.string().uuid().optional(), status: z.string().optional(), search: z.string().max(80).optional(), offset: z.number().int().min(0).default(0),
  }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    await requireStaff(input.token, 'reservations');
    const today = tehranToday();
    const dbStatus = input.status === 'Expired' ? 'Reserved' : input.status;
    const rows = await queryReservations({ ...input, status: dbStatus, limit: 100 });
    return {
      reservations: rows
        .map((r) => ({ ...r, status: effectiveStatus(r.status, r.serviceDate, today) }))
        .filter((r) => !input.status || r.status === input.status),
      hasMore: rows.length === 100,
    };
  },
});
