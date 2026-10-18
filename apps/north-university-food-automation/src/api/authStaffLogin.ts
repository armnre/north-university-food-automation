import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, checkThrottle, clearThrottle, createSession, fail, recordFailure, verifyPassword } from '../server/core';

export default createEndpoint({
  description: 'Signs a staff user in with username and password',
  inputSchema: z.object({ username: z.string().max(64), password: z.string().max(200) }),
  outputSchema: z.object({ token: z.string() }),
  execute: async ({ input }) => {
    const username = input.username.trim().toLowerCase();
    if (!username || !input.password) fail('BAD_REQUEST', 'نام کاربری و رمز عبور را وارد کنید.');
    const key = `staff:${username}`;
    const throttle = await checkThrottle(key);
    const staff = await zite.staffUsers.findOne({ filters: { username } });
    const ok = !!staff?.passwordHash && (await verifyPassword(input.password, staff.passwordHash));
    if (!ok || !staff) {
      const locked = await recordFailure(key, throttle?.failures ?? 0);
      await audit({ type: 'Anonymous', id: '', label: username }, locked ? 'login.staff.locked' : 'login.staff.failed', 'StaffUser', staff?.id ?? '', {});
      fail('UNAUTHORIZED', 'نام کاربری یا رمز عبور صحیح نیست.');
    }
    if (staff.status !== 'Active') fail('FORBIDDEN', 'حساب کاربری شما غیرفعال است.');
    await clearThrottle(key);
    const token = await createSession('Staff', staff.id, 8);
    await audit({ type: 'Staff', id: staff.id, label: staff.fullName ?? username }, 'login.staff.success', 'StaffUser', staff.id);
    return { token };
  },
});
