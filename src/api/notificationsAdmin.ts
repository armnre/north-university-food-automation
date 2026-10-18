import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, normalizeDigits, requireStaff, staffActor } from '../server/core';

export default createEndpoint({
  description: 'Sends a notification to all students or one student, and lists recent notifications',
  inputSchema: z.object({ token: z.string(), send: z.object({ title: z.string().min(2).max(150), body: z.string().min(2).max(2000), studentNumber: z.string().max(20).optional() }).optional() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'notify');
    if (input.send) {
      let studentId: string | null = null;
      if (input.send.studentNumber?.trim()) {
        const s = await zite.students.findOne({ filters: { studentNumber: normalizeDigits(input.send.studentNumber) } });
        if (!s) fail('NOT_FOUND', 'دانشجویی با این شماره یافت نشد.');
        studentId = s.id;
      }
      const n = await db.notifications.create({ record: { title: input.send.title, body: input.send.body, student: studentId ? [studentId] : null } });
      await audit(staffActor(staff), 'notification.send', 'Notification', n.id, { broadcast: !studentId });
    }
    const r = await zite.sql({
      query: `SELECT n.id, n."title", n."body", n.created_at AS "createdAt", (SELECT s."studentNumber" FROM "NotificationsStudents" ns JOIN "Students" s ON s.id=ns."studentsId" WHERE ns."notificationsId"=n.id LIMIT 1) AS "studentNumber"
        FROM "Notifications" n ORDER BY n.created_at DESC LIMIT 50`,
    });
    return { notifications: r.rows.map((x) => ({ id: String(x.id), title: String(x.title ?? ''), body: String(x.body ?? ''), createdAt: String(x.createdAt ?? ''), studentNumber: x.studentNumber ? String(x.studentNumber) : null })) };
  },
});
