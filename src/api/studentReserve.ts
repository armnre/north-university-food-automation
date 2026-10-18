import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { addHistory, audit, balanceOf, db, fail, first, postLedger, randomCode, randomHex, requireStudent, studentActor, tehranToday } from '../server/core';

/**
 * Reservation engine. Zite's DB API exposes no multi-statement transactions or row locks,
 * so consistency is enforced with an insert-then-verify pattern (see docs/RESERVATIONS.md):
 *  1. idempotent insert (upsert on idempotency key)  2. idempotent debit
 *  3. re-read ordered by autonumber; if this row ranks beyond capacity / is a duplicate slot / balance went negative,
 *     it is marked Rejected and refunded. The earliest writers always win, so capacity is never exceeded.
 */
export default createEndpoint({
  description: 'Reserves a meal for the signed-in student and debits the wallet',
  inputSchema: z.object({ token: z.string(), offeringId: z.string().uuid(), idempotencyKey: z.string().min(8).max(80) }),
  outputSchema: z.object({ reservationId: z.string(), code: z.string(), replay: z.boolean() }),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const idemKey = `${student.id}:${input.idempotencyKey}`;
    const prior = await zite.reservations.findOne({ filters: { idempotencyKey: idemKey } });
    if (prior) {
      if (prior.status === 'Rejected') fail('CONFLICT', 'ظرفیت این وعده تکمیل شده یا رزرو قبلاً رد شده است.');
      return { reservationId: prior.id, code: prior.code ?? '', replay: true };
    }

    const offering = await zite.mealOfferings.findOne({ id: input.offeringId });
    if (!offering || !offering.active) fail('NOT_FOUND', 'این وعده برای رزرو در دسترس نیست.');
    const serviceDate = String(offering.serviceDate ?? '').slice(0, 10);
    if (serviceDate < tehranToday()) fail('BAD_REQUEST', 'زمان این وعده گذشته است.');
    if (!offering.reserveDeadline || new Date(offering.reserveDeadline) <= new Date()) fail('BAD_REQUEST', 'مهلت رزرو این وعده به پایان رسیده است.');
    const price = Math.round(offering.priceRial ?? 0);
    const capacity = Math.floor(offering.capacity ?? 0);
    if (price < 0 || capacity <= 0) fail('BAD_REQUEST', 'این وعده به‌درستی تنظیم نشده است.');

    const slotTaken = await zite.sql({
      query: `SELECT COUNT(*) AS n FROM "Reservations" r
        JOIN "ReservationsStudents" rs ON rs."reservationsId" = r.id
        JOIN "MealOfferingsReservations" mr ON mr."reservationsId" = r.id JOIN "MealOfferings" o ON o.id = mr."mealOfferingsId"
        WHERE rs."studentsId" = $1 AND r."status" IN ('Reserved','Delivered') AND o."serviceDate" = $2::date AND o."mealType" = $3`,
      params: [student.id, serviceDate, offering.mealType],
    });
    if (Number(slotTaken.rows[0]?.n) > 0) fail('CONFLICT', 'شما برای این وعده قبلاً رزرو دارید.');
    if ((await balanceOf(student.id)) < price) fail('PAYMENT_REQUIRED', 'موجودی کیف پول شما برای این رزرو کافی نیست.');

    const created = await db.reservations.bulkCreate({
      records: [{ code: `R-${randomCode(8)}`, student: [student.id], offering: [offering.id], priceAtBooking: price, status: 'Reserved', idempotencyKey: idemKey, qrToken: randomHex(24) }],
      matchOn: ['idempotencyKey'],
    });
    const res = created.records[0];
    if (price > 0) await postLedger({ studentId: student.id, type: 'ReservationDebit', amount: -price, counter: 'meal-revenue', reservationId: res.id, reason: 'کسر بابت رزرو غذا', key: `res:${res.id}:debit` });

    // ---- verify (concurrency guard) ----
    const live = await zite.sql({
      query: `SELECT r.id, r."seq", (rs."studentsId" = $2) AS mine FROM "Reservations" r
        JOIN "MealOfferingsReservations" mr ON mr."reservationsId" = r.id
        JOIN "ReservationsStudents" rs ON rs."reservationsId" = r.id
        WHERE mr."mealOfferingsId" = $1 AND r."status" IN ('Reserved','Delivered') ORDER BY r."seq" ASC`,
      params: [offering.id, student.id],
    });
    const rank = live.rows.findIndex((r) => String(r.id) === res.id) + 1;
    const earlierMine = live.rows.some((r) => r.mine && String(r.id) !== res.id && Number(r.seq) < Number(res.seq));
    const overCapacity = rank === 0 || rank > capacity;
    const negative = (await balanceOf(student.id)) < 0;

    if (overCapacity || earlierMine || negative) {
      await db.reservations.update({ id: res.id, record: { status: 'Rejected' } });
      if (price > 0) await postLedger({ studentId: student.id, type: 'CapacityRefund', amount: price, counter: 'meal-revenue', reservationId: res.id, reason: 'بازگشت وجه رزرو ردشده', key: `res:${res.id}:reject-refund` });
      await addHistory(res.id, 'Reserved', 'Rejected', 'system', overCapacity ? 'capacity' : earlierMine ? 'duplicate-slot' : 'insufficient-balance');
      fail('CONFLICT', overCapacity ? 'متأسفانه ظرفیت این وعده هم‌اکنون تکمیل شد. مبلغ به کیف پول برگشت داده شد.' : earlierMine ? 'شما برای این وعده قبلاً رزرو دارید.' : 'موجودی کیف پول شما کافی نیست.');
    }

    await addHistory(res.id, '', 'Reserved', `student:${student.studentNumber}`, 'reserve');
    await audit(studentActor(student), 'reservation.create', 'Reservation', res.id, { offeringId: offering.id, price, cafeteria: first(offering.cafeteria) });
    return { reservationId: res.id, code: res.code ?? '', replay: false };
  },
});
