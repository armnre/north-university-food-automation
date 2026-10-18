import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';

export default createEndpoint({
  description: 'Tells whether the first administrator still needs to be created',
  inputSchema: z.object({}),
  outputSchema: z.object({ needsSetup: z.boolean() }),
  execute: async () => {
    const r = await zite.staffUsers.findAll({ limit: 1, fields: ['username'] });
    return { needsSetup: r.records.length === 0 };
  },
});
