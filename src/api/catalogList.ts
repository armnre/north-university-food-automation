import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, first, requireStaff, ROLE_PERMS } from '../server/core';

export default createEndpoint({
  description: 'Lists contractors, cafeterias and foods for management screens',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token);
    const perms = ROLE_PERMS[staff.role as keyof typeof ROLE_PERMS] ?? [];
    if (!['catalog', 'foods', 'menu', 'reports', 'finance', 'students'].some((p) => perms.includes(p as never))) fail('FORBIDDEN', 'شما مجوز مشاهده‌ی این بخش را ندارید.');
    const [contractors, cafeterias, foods] = await Promise.all([
      zite.contractors.findAll({ limit: 500 }),
      zite.cafeterias.findAll({ limit: 500 }),
      zite.foods.findAll({ limit: 2000 }),
    ]);
    const cName = new Map(contractors.records.map((c) => [c.id, c.name ?? '']));
    return {
      contractors: contractors.records.map((c) => ({ id: c.id, name: c.name ?? '', contractNumber: c.contractNumber ?? '', contactPhone: c.contactPhone ?? '', active: !!c.active })).sort((a, b) => a.name.localeCompare(b.name, 'fa')),
      cafeterias: cafeterias.records.map((c) => ({ id: c.id, name: c.name ?? '', location: c.location ?? '', active: !!c.active, contractorId: first(c.contractor) ?? null, contractorName: cName.get(first(c.contractor) ?? '') ?? '' })).sort((a, b) => a.name.localeCompare(b.name, 'fa')),
      foods: foods.records.map((f) => ({ id: f.id, name: f.name ?? '', description: f.description ?? '', active: !!f.active, isDemo: !!f.isDemo, category: f.category ?? '', defaultPriceRial: f.defaultPriceRial ?? null, defaultCapacity: f.defaultCapacity ?? null, suitableMeals: f.suitableMeals ?? [], imageUrl: f.imageUrl ?? '' })).sort((a, b) => a.name.localeCompare(b.name, 'fa')),
    };
  },
});
