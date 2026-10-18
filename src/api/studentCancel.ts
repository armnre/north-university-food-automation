import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { addHistory, audit, db, fail, first, postLedger, requireStudent, studentActor } from '../server/core';

export default createEndpoint({
  description: 'Cancels a reservation before its cancel deadline and refunds the booked price',
  inputSchema: z.object({ token: z.string(), reservationId: z.string().uuid() }),
  outputSchema: z.object({ ok: z.boolean(), refunded: z.number() }),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const res = await zite.reservations.findOne({ id: input.reservationId });
    if (!res || first(res.student) !== student.id) fail('NOT_FOUND', 'رزرو موردنظر یافت نشد.');
    if (res.status === 'Cancelled') return { ok: true, refunded: 0 };
    if (res.status !== 'Reserved') fail('BAD_REQUEST', 'این رزرو قابل لغو نیست.');
    const offering = await zite.mealOfferings.findOne({ id: first(res.offering)! });
    if (!offering?.cancelDeadline || new Date(offering.cancelDeadline) <= new Date()) fail('BAD_REQUEST', 'مهلت لغو این رزرو به پایان رسیده است.');
    await db.reservations.update({ id: res.id, record: { status: 'Cancelled' } });
    const amount = Math.round(res.priceAtBooking ?? 0);
    // Refund the price captured at booking time (not the current price). Idempotent key prevents double refunds.
    if (amount > 0) await postLedger({ studentId: student.id, type: 'CancellationRefund', amount, counter: 'meal-revenue', reservationId: res.id, reason: 'بازپرداخت لغو رزرو', key: `res:${res.id}:refund` });
    await addHistory(res.id, 'Reserved', 'Cancelled', `student:${student.studentNumber}`, 'cancel');
    await audit(studentActor(student), 'reservation.cancel', 'Reservation', res.id, { amount });
    return { ok: true, refunded: amount };
  },
});
