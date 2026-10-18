import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, balanceOf, fail, normalizeDigits, postLedger, requireStaff, staffActor } from '../server/core';

export default createEndpoint({
  description: 'Posts a manual wallet credit or debit by an authorised finance user with a mandatory reason',
  inputSchema: z.object({
    token: z.string(), studentNumber: z.string().max(20), direction: z.enum(['credit', 'debit']),
    amountRial: z.number().int().min(1).max(500_000_000), reason: z.string().min(5).max(500), idempotencyKey: z.string().min(8).max(80),
  }),
  outputSchema: z.object({ trackingCode: z.string(), balanceRial: z.number() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'financeWrite');
    const student = await zite.students.findOne({ filters: { studentNumber: normalizeDigits(input.studentNumber) } });
    if (!student) fail('NOT_FOUND', 'دانشجویی با این شماره یافت نشد.');
    const amount = input.direction === 'credit' ? input.amountRial : -input.amountRial;
    if (amount < 0 && (await balanceOf(student.id)) + amount < 0) fail('BAD_REQUEST', 'این برداشت موجودی را منفی می‌کند و مجاز نیست.');
    const entry = await postLedger({
      studentId: student.id, type: input.direction === 'credit' ? 'ManualCredit' : 'ManualDebit', amount,
      counter: 'manual-cash', actorStaffId: staff.id, reason: input.reason, key: `manual:${staff.id}:${input.idempotencyKey}`,
    });
    const balance = await balanceOf(student.id);
    if (balance < 0) fail('CONFLICT', 'به دلیل تراکنش هم‌زمان، موجودی ناسازگار شد. با مدیر سامانه تماس بگیرید.');
    await audit(staffActor(staff), `ledger.manual.${input.direction}`, 'Student', student.id, { amount, trackingCode: entry.trackingCode, reason: input.reason });
    return { trackingCode: entry.trackingCode ?? '', balanceRial: balance };
  },
});
