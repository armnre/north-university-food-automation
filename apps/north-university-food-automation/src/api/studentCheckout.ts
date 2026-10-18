import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, fail, postLedger, randomCode, requireStudent, studentActor } from '../server/core';
import { reserveOne } from '../server/reserve';

/**
 * Cart checkout: the gateway payment for the invoice total is posted as a credit,
 * then each meal is reserved (debited). Any item that fails stays as wallet credit.
 * NOTE: the payment step is a test gateway until a real Iranian PSP is connected.
 */
export default createEndpoint({
  description: 'Pays a cart invoice through the payment gateway and reserves every meal in it',
  inputSchema: z.object({ token: z.string(), offeringIds: z.array(z.string().uuid()).min(1).max(30), idempotencyKey: z.string().min(8).max(80) }),
  outputSchema: z.object({
    trackingCode: z.string(), paidRial: z.number(),
    results: z.array(z.object({ offeringId: z.string(), ok: z.boolean(), code: z.string().optional(), error: z.string().optional() })),
  }),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const ids = [...new Set(input.offeringIds)];
    const records = (await Promise.all(ids.map((id) => zite.mealOfferings.findOne({ id })))).filter((o): o is NonNullable<typeof o> => !!o);
    if (records.length !== ids.length) fail('BAD_REQUEST', 'برخی از غذاهای سبد دیگر در دسترس نیستند. سبد را بررسی کنید.');
    const total = records.reduce((s, o) => s + Math.round(o.priceRial ?? 0), 0);
    const key = `${student.id}:${input.idempotencyKey}`;
    const payment = total > 0
      ? await postLedger({ studentId: student.id, type: 'OnlinePayment', amount: total, counter: 'payment-gateway', reason: `پرداخت فاکتور (${ids.length} قلم)`, key: `pay:${key}` })
      : null;
    const results: { offeringId: string; ok: boolean; code?: string; error?: string }[] = [];
    for (const id of ids) {
      try {
        const r = await reserveOne(student, id, `${key}:${id}`);
        results.push({ offeringId: id, ok: true, code: r.code });
      } catch (e) {
        const msg = (e as { userFacingMessage?: string }).userFacingMessage ?? 'رزرو انجام نشد.';
        results.push({ offeringId: id, ok: false, error: msg });
      }
    }
    await audit(studentActor({ id: student.id, studentNumber: student.studentNumber ?? '' }), 'checkout.pay', 'Student', student.id, { total, items: ids.length, ok: results.filter((r) => r.ok).length });
    return { trackingCode: (payment?.trackingCode as string | undefined) ?? `TX-${randomCode(10)}`, paidRial: total, results };
  },
});
