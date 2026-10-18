import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { addHistory, audit, db, first, randomCode, requireStaff, staffActor } from '../server/core';
import { inspectToken } from '../server/delivery';

/**
 * Atomic-by-ordering delivery: every attempt inserts a Delivery row; the earliest Accepted row (by autonumber)
 * wins. A concurrent second operator sees their row lose and gets "already delivered" — never two successes.
 */
export default createEndpoint({
  description: 'Records meal delivery for a QR token exactly once',
  inputSchema: z.object({ token: z.string(), qrToken: z.string().max(200) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'delivery');
    const r = await inspectToken(input.qrToken, staff.role === 'Operator' ? first(staff.cafeteria) : undefined);
    if (r.state !== 'ready' || !r.res) return { state: r.state, info: r.info ?? null };

    const mine = await db.deliveries.create({ record: { deliveryCode: `D-${randomCode(10)}`, reservation: [r.res.id], operator: [staff.id], outcome: 'Accepted' } });
    const all = await zite.sql({
      query: `SELECT d.id FROM "Deliveries" d JOIN "DeliveriesReservations" l ON l."deliveriesId"=d.id WHERE l."reservationsId"=$1 AND d."outcome"='Accepted' ORDER BY d."seq" ASC LIMIT 1`,
      params: [r.res.id],
    });
    if (String(all.rows[0]?.id) !== mine.id) {
      await db.deliveries.update({ id: mine.id, record: { outcome: 'Duplicate' } });
      await audit(staffActor(staff), 'delivery.duplicate', 'Reservation', r.res.id);
      return { state: 'already', info: r.info };
    }
    await db.reservations.update({ id: r.res.id, record: { status: 'Delivered' } });
    await addHistory(r.res.id, 'Reserved', 'Delivered', `staff:${staff.username}`, 'delivered');
    await audit(staffActor(staff), 'delivery.accept', 'Reservation', r.res.id, { deliveryId: mine.id });
    return { state: 'delivered', info: r.info, deliveredAt: new Date().toISOString() };
  },
});
