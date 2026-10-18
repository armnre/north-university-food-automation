import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { requireStaff } from '../server/core';
import { queryOfferings } from '../server/queries';

export default createEndpoint({
  description: 'Lists meal offerings with live reservation, delivery and remaining-capacity counts',
  inputSchema: z.object({ token: z.string(), from: z.string().optional(), to: z.string().optional(), cafeteriaId: z.string().uuid().optional() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    await requireStaff(input.token, 'menu');
    return { offerings: await queryOfferings({ from: input.from, to: input.to, cafeteriaId: input.cafeteriaId }) };
  },
});
