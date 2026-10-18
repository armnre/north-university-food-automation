import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, requireStaff, staffActor } from '../server/core';
import { queryOfferings } from '../server/queries';

/**
 * Price changes never touch existing reservations: each reservation stores priceAtBooking,
 * and refunds use that snapshot. Capacity may not drop below the number of live reservations.
 */
export default createEndpoint({
  description: 'Creates or updates a meal offering (date, meal, food, cafeteria, price, capacity, deadlines)',
  inputSchema: z.object({
    token: z.string(),
    id: z.string().uuid().optional(),
    serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    mealType: z.enum(['Breakfast', 'Lunch', 'Dinner']),
    foodId: z.string().uuid(),
    cafeteriaId: z.string().uuid(),
    priceRial: z.number().int().min(0).max(100_000_000),
    capacity: z.number().int().min(1).max(100_000),
    reserveDeadline: z.string(),
    cancelDeadline: z.string(),
    active: z.boolean(),
    notes: z.string().max(1000),
    reason: z.string().max(500).optional(),
  }),
  outputSchema: z.object({ id: z.string() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'menu');
    const rd = new Date(input.reserveDeadline), cd = new Date(input.cancelDeadline);
    if (isNaN(+rd) || isNaN(+cd)) fail('BAD_REQUEST', 'مهلت‌ها نامعتبر هستند.');
    const [food, caf] = await Promise.all([zite.foods.findOne({ id: input.foodId }), zite.cafeterias.findOne({ id: input.cafeteriaId })]);
    if (!food || !caf) fail('BAD_REQUEST', 'غذا یا سلف انتخاب‌شده معتبر نیست.');
    const record = {
      serviceDate: input.serviceDate, mealType: input.mealType, food: [input.foodId], cafeteria: [input.cafeteriaId], priceRial: input.priceRial,
      capacity: input.capacity, reserveDeadline: rd.toISOString(), cancelDeadline: cd.toISOString(), active: input.active, notes: input.notes,
    };
    if (input.id) {
      const [current] = await queryOfferings({ id: input.id });
      if (!current) fail('NOT_FOUND', 'وعده یافت نشد.');
      if (input.capacity < current.reserved) fail('BAD_REQUEST', `ظرفیت نمی‌تواند کمتر از تعداد رزروهای فعلی (${current.reserved}) باشد.`);
      if (current.reserved > 0 && (current.serviceDate !== input.serviceDate || current.mealType !== input.mealType || current.cafeteriaId !== input.cafeteriaId)) {
        fail('BAD_REQUEST', 'برای وعده‌ای که رزرو دارد، تاریخ، نوع وعده و سلف قابل تغییر نیست.');
      }
      if ((current.priceRial !== input.priceRial || current.capacity !== input.capacity) && !input.reason?.trim()) fail('BAD_REQUEST', 'برای تغییر قیمت یا ظرفیت، ثبت دلیل الزامی است.');
      await db.mealOfferings.update({ id: input.id, record });
      await audit(staffActor(staff), 'offering.update', 'MealOffering', input.id, { fromPrice: current.priceRial, toPrice: input.priceRial, fromCapacity: current.capacity, toCapacity: input.capacity, reason: input.reason ?? '' });
      return { id: input.id };
    }
    const created = await db.mealOfferings.create({ record });
    await audit(staffActor(staff), 'offering.create', 'MealOffering', created.id, record);
    return { id: created.id };
  },
});
