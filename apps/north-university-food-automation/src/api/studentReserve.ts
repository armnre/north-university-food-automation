import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { requireStudent } from '../server/core';
import { reserveOne } from '../server/reserve';

export default createEndpoint({
  description: 'Reserves a meal for the signed-in student and debits the wallet',
  inputSchema: z.object({ token: z.string(), offeringId: z.string().uuid(), idempotencyKey: z.string().min(8).max(80) }),
  outputSchema: z.object({ reservationId: z.string(), code: z.string(), replay: z.boolean() }),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    return reserveOne(student, input.offeringId, `${student.id}:${input.idempotencyKey}`);
  },
});
