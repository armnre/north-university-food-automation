import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, checkThrottle, clearThrottle, createSession, fail, hashNationalId, isValidNationalId, normalizeDigits, recordFailure, sha256 } from '../server/core';

const GENERIC = 'شماره دانشجویی یا کد ملی صحیح نیست.';

export default createEndpoint({
  description: 'Signs a student in with student number and national id',
  inputSchema: z.object({ studentNumber: z.string().max(20), nationalId: z.string().max(20) }),
  outputSchema: z.object({ token: z.string() }),
  execute: async ({ input }) => {
    const sn = normalizeDigits(input.studentNumber);
    const nid = normalizeDigits(input.nationalId);
    if (!/^\d{5,15}$/.test(sn) || !nid) fail('BAD_REQUEST', 'شماره دانشجویی و کد ملی را کامل وارد کنید.');
    const key = `student:${await sha256(sn)}`;
    const throttle = await checkThrottle(key);
    const student = await zite.students.findOne({ filters: { studentNumber: sn } });
    const ok = isValidNationalId(nid) && !!student?.nationalIdHash && student.nationalIdHash === (await hashNationalId(nid));
    if (!ok || !student) {
      const locked = await recordFailure(key, throttle?.failures ?? 0);
      await audit({ type: 'Anonymous', id: '', label: '' }, locked ? 'login.student.locked' : 'login.student.failed', 'StudentNumberHash', key, {});
      fail('UNAUTHORIZED', GENERIC);
    }
    if (student.status !== 'Active') fail('FORBIDDEN', 'حساب شما غیرفعال است. با معاونت دانشجویی تماس بگیرید.');
    await clearThrottle(key);
    const token = await createSession('Student', student.id, 12);
    await audit({ type: 'Student', id: student.id, label: sn }, 'login.student.success', 'Student', student.id);
    return { token };
  },
});
