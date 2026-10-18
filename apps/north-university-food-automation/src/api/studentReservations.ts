import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { requireStudent, tehranToday } from '../server/core';
import { effectiveStatus, queryReservations } from '../server/queries';

export default createEndpoint({
  description: 'Lists the signed-in student’s reservations with QR tokens for active ones',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const today = tehranToday();
    const rows = await queryReservations({ studentId: student.id, limit: 300 });
    const visible = rows.filter((r) => r.status !== 'Rejected');
    const activeIds = visible.filter((r) => effectiveStatus(r.status, r.serviceDate, today) === 'Reserved').map((r) => r.id);
    const tokens = activeIds.length ? (await zite.reservations.findAll({ filters: { id: { in: activeIds } }, fields: ['qrToken'], limit: 500 })).records : [];
    const now = Date.now();
    return {
      today,
      reservations: visible.map((r) => {
        const status = effectiveStatus(r.status, r.serviceDate, today);
        return {
          id: r.id, code: r.code, status, priceAtBooking: r.priceAtBooking, createdAt: r.createdAt, serviceDate: r.serviceDate,
          mealType: r.mealType, foodName: r.foodName, cafeteriaName: r.cafeteriaName, deliveredAt: r.deliveredAt, cancelDeadline: r.cancelDeadline,
          canCancel: status === 'Reserved' && !!r.cancelDeadline && new Date(r.cancelDeadline).getTime() > now,
          qrToken: status === 'Reserved' ? tokens.find((t) => t.id === r.id)?.qrToken ?? null : null,
        };
      }),
    };
  },
});
