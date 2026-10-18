import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { requireStudent, tehranToday } from '../server/core';
import { queryOfferings, queryReservations } from '../server/queries';

export default createEndpoint({
  description: 'Lists active meal offerings for a date range with remaining capacity and the student’s own bookings',
  inputSchema: z.object({ token: z.string(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const today = tehranToday();
    const offerings = await queryOfferings({ from: input.from < today ? today : input.from, to: input.to, onlyActive: true });
    const mine = await queryReservations({ studentId: student.id, from: input.from, to: input.to });
    const now = Date.now();
    return {
      today,
      offerings: offerings.map((o) => {
        const my = mine.find((r) => r.offeringId === o.id && (r.status === 'Reserved' || r.status === 'Delivered'));
        const slotTaken = mine.some((r) => r.serviceDate === o.serviceDate && r.mealType === o.mealType && (r.status === 'Reserved' || r.status === 'Delivered'));
        const open = !!o.reserveDeadline && new Date(o.reserveDeadline).getTime() > now;
        return {
          id: o.id, serviceDate: o.serviceDate, mealType: o.mealType, foodName: o.foodName, foodDescription: o.foodDescription,
          cafeteriaName: o.cafeteriaName, priceRial: o.priceRial, capacity: o.capacity, remaining: o.remaining, notes: o.notes,
          reserveDeadline: o.reserveDeadline, cancelDeadline: o.cancelDeadline, open,
          myReservationId: my?.id ?? null, myStatus: my?.status ?? null, slotTaken,
        };
      }),
    };
  },
});
