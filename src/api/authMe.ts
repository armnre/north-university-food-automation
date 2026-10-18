import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { fail, ROLE_PERMS, sha256, type StaffRole } from '../server/core';

export default createEndpoint({
  description: 'Returns the signed-in student or staff profile for a session',
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const s = await zite.sessions.findOne({ filters: { tokenHash: await sha256(input.token || '') } });
    if (!s || s.revoked || !s.expiresAt || new Date(s.expiresAt) < new Date()) fail('UNAUTHORIZED', 'نشست منقضی شده است.');
    if (s.subjectType === 'Student') {
      const st = await zite.students.findOne({ id: s.subjectId! });
      if (!st || st.status !== 'Active') fail('FORBIDDEN', 'حساب دانشجویی فعال نیست.');
      return {
        kind: 'student' as const,
        student: { id: st.id, studentNumber: st.studentNumber ?? '', fullName: st.fullName ?? '', faculty: st.faculty ?? '', major: st.major ?? '', degree: st.degree ?? '', entryYear: st.entryYear ?? null, nationalIdMasked: `••••••${st.nationalIdLastDigits ?? '••••'}` },
      };
    }
    const u = await zite.staffUsers.findOne({ id: s.subjectId! });
    if (!u || u.status !== 'Active') fail('FORBIDDEN', 'حساب کاربری غیرفعال است.');
    const role = u.role as StaffRole;
    return { kind: 'staff' as const, staff: { id: u.id, username: u.username ?? '', fullName: u.fullName ?? '', role, perms: ROLE_PERMS[role] ?? [] } };
  },
});
