import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, requireStaff, staffActor } from '../server/core';

export default createEndpoint({
  description: 'Activates or deactivates a student',
  inputSchema: z.object({ token: z.string(), studentId: z.string().uuid(), status: z.enum(['Active', 'Inactive'])}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'students');
    const s = await zite.students.findOne({ id: input.studentId });
    if (!s) fail('NOT_FOUND', 'دانشجو یافت نشد.');
    await db.students.update({ id: s.id, record: { status: input.status } });
    await audit(staffActor(staff), 'student.status', 'Student', s.id, { from: s.status, to: input.status });
    return { ok: true };
  },
});
