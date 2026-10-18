import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { audit, first, requireStaff, staffActor } from '../server/core';
import { inspectToken } from '../server/delivery';

export default createEndpoint({
  description: 'Validates a scanned QR token for the operator without delivering',
  inputSchema: z.object({ token: z.string(), qrToken: z.string().max(200) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'delivery');
    const r = await inspectToken(input.qrToken, staff.role === 'Operator' ? first(staff.cafeteria) : undefined);
    if (r.state === 'invalid') await audit(staffActor(staff), 'delivery.scan.invalid', 'QR', '', {});
    return { state: r.state, info: r.info ?? null };
  },
});
