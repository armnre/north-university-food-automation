import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, requireStaff, staffActor } from '../server/core';

export default createEndpoint({
  description: 'Cancels a previewed import batch before it is committed',
  inputSchema: z.object({ token: z.string(), batchId: z.string().uuid() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'import');
    const b = await zite.importBatches.findOne({ id: input.batchId });
    if (!b) fail('NOT_FOUND', 'دسته یافت نشد.');
    if (b.status !== 'Preview') fail('BAD_REQUEST', 'فقط دسته‌های در حال پیش‌نمایش قابل لغو هستند.');
    await db.importBatches.update({ id: b.id, record: { status: 'Cancelled', stagedData: '' } });
    await audit(staffActor(staff), 'import.cancel', 'ImportBatch', b.id);
    return { ok: true };
  },
});
