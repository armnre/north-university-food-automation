import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { revokeSession } from '../server/core';

export default createEndpoint({
  description: 'Revokes the current session on the server',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ input }) => {
    if (input.token) await revokeSession(input.token);
    return { ok: true };
  },
});
