import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { audit, db, requireStaff, staffActor } from '../server/core';

const item = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contractor'), id: z.string().uuid().optional(), name: z.string().min(2).max(150), contractNumber: z.string().max(80), contactPhone: z.string().max(30), active: z.boolean() }),
  z.object({ kind: z.literal('cafeteria'), id: z.string().uuid().optional(), name: z.string().min(2).max(150), location: z.string().max(200), contractorId: z.string().uuid().nullable(), active: z.boolean() }),
  z.object({ kind: z.literal('food'), id: z.string().uuid().optional(), name: z.string().min(2).max(150), description: z.string().max(1000), active: z.boolean(), isDemo: z.boolean() }),
]);

export default createEndpoint({
  description: 'Creates or updates a contractor, cafeteria or food (records are deactivated, not deleted)',
  inputSchema: z.object({ token: z.string(), item }),
  outputSchema: z.object({ id: z.string() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'catalog');
    const it = input.item;
    const table = it.kind === 'contractor' ? db.contractors : it.kind === 'cafeteria' ? db.cafeterias : db.foods;
    const record =
      it.kind === 'contractor' ? { name: it.name, contractNumber: it.contractNumber, contactPhone: it.contactPhone || null, active: it.active }
      : it.kind === 'cafeteria' ? { name: it.name, location: it.location, contractor: it.contractorId ? [it.contractorId] : null, active: it.active }
      : { name: it.name, description: it.description, active: it.active, isDemo: it.isDemo };
    let id = it.id;
    if (id) await table.update({ id, record });
    else id = (await table.create({ record })).id as string;
    await audit(staffActor(staff), `${it.kind}.${it.id ? 'update' : 'create'}`, it.kind, id!, record);
    return { id: id! };
  },
});
