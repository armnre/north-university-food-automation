import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, requireStaff, staffActor } from '../server/core';

const SETTING_KEYS = ['supportText', 'helpText', 'reservationPolicyNote', 'cancellationPolicyNote'] as const;

export default createEndpoint({
  description: 'Reads or updates system settings (support text, help text, policy notes)',
  inputSchema: z.object({ token: z.string(), values: z.record(z.enum(SETTING_KEYS), z.string().max(3000)).optional() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'settings');
    if (input.values) {
      const records = Object.entries(input.values).map(([key, value]) => ({ key, value }));
      if (records.length) await db.systemSettings.bulkCreate({ records, matchOn: ['key'] });
      await audit(staffActor(staff), 'settings.update', 'SystemSettings', '', { keys: Object.keys(input.values) });
    }
    const all = await zite.systemSettings.findAll({ limit: 100 });
    const values: Record<string, string> = {};
    for (const k of SETTING_KEYS) values[k] = all.records.find((r) => r.key === k)?.value ?? '';
    return { values };
  },
});
