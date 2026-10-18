import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { getSetting, requireStudent } from '../server/core';

export default createEndpoint({
  description: 'Lists notifications for the signed-in student (personal and broadcast) and support info',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const student = await requireStudent(input.token);
    const r = await zite.sql({
      query: `SELECT n.id, n."title", n."body", n.created_at AS "createdAt",
          EXISTS(SELECT 1 FROM "NotificationsStudents" ns WHERE ns."notificationsId" = n.id) AS personal
        FROM "Notifications" n
        WHERE NOT EXISTS(SELECT 1 FROM "NotificationsStudents" ns WHERE ns."notificationsId" = n.id)
           OR EXISTS(SELECT 1 FROM "NotificationsStudents" ns WHERE ns."notificationsId" = n.id AND ns."studentsId" = $1)
        ORDER BY n.created_at DESC LIMIT 100`,
      params: [student.id],
    });
    return {
      notifications: r.rows.map((x) => ({ id: String(x.id), title: String(x.title ?? ''), body: String(x.body ?? ''), createdAt: String(x.createdAt ?? ''), personal: !!x.personal })),
      supportText: await getSetting('supportText'),
      helpText: await getSetting('helpText'),
    };
  },
});
