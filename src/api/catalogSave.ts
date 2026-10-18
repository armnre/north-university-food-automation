import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { audit, db, fail, requireStaff, staffActor } from '../server/core';

const MEAL = z.enum(['Breakfast', 'Lunch', 'Dinner']);

const item = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contractor'), id: z.string().uuid().optional(), name: z.string().min(2).max(150), contractNumber: z.string().max(80), contactPhone: z.string().max(30), active: z.boolean() }),
  z.object({ kind: z.literal('cafeteria'), id: z.string().uuid().optional(), name: z.string().min(2).max(150), location: z.string().max(200), contractorId: z.string().uuid().nullable(), active: z.boolean() }),
  z.object({ kind: z.literal('food'), id: z.string().uuid().optional(), name: z.string().min(2).max(150), description: z.string().max(1000), active: z.boolean(), isDemo: z.boolean(), category: z.string().max(60).optional(), defaultPriceRial: z.number().int().min(0).max(100_000_000).nullable().optional(), defaultCapacity: z.number().int().min(0).max(100_000).nullable().optional(), suitableMeals: z.array(MEAL).optional(), imageUrl: z.string().max(1000).optional() }),
]);

export default createEndpoint({
  description: 'Creates or updates a contractor, cafeteria or food (records are deactivated, not deleted)',
  inputSchema: z.object({ token: z.string(), item }),
  outputSchema: z.object({ id: z.string() }),
  execute: async ({ input }) => {
    const it = input.item;
    const staff = await requireStaff(input.token, it.kind === 'food' ? 'foods' : 'catalog');
    if (it.kind === 'food' && it.imageUrl && !/^https:\/\//.test(it.imageUrl)) fail('BAD_REQUEST', 'آدرس تصویر باید با https شروع شود.');
    const table = it.kind === 'contractor' ? db.contractors : it.kind === 'cafeteria' ? db.cafeterias : db.foods;
    const record =
      it.kind === 'contractor' ? { name: it.name, contractNumber: it.contractNumber, contactPhone: it.contactPhone || null, active: it.active }
      : it.kind === 'cafeteria' ? { name: it.name, location: it.location, contractor: it.contractorId ? [it.contractorId] : null, active: it.active }
      : {
        name: it.name, description: it.description, active: it.active, isDemo: it.isDemo,
        ...(it.category !== undefined ? { category: it.category || null } : {}),
        ...(it.defaultPriceRial !== undefined ? { defaultPriceRial: it.defaultPriceRial } : {}),
        ...(it.defaultCapacity !== undefined ? { defaultCapacity: it.defaultCapacity } : {}),
        ...(it.suitableMeals !== undefined ? { suitableMeals: it.suitableMeals } : {}),
        ...(it.imageUrl !== undefined ? { imageUrl: it.imageUrl || null } : {}),
      };
    let id = it.id;
    if (id) await table.update({ id, record });
    else id = (await table.create({ record })).id as string;
    await audit(staffActor(staff), `${it.kind}.${it.id ? 'update' : 'create'}`, it.kind, id!, record);
    return { id: id! };
  },
});
