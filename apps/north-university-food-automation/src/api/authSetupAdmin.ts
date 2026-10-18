import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, hashPassword, sha256 } from '../server/core';

export default createEndpoint({
  description: 'Creates the first super admin using the one-time setup code',
  inputSchema: z.object({ setupCode: z.string(), username: z.string().min(3).max(64), fullName: z.string().min(2).max(100), password: z.string().min(10).max(200) }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ input }) => {
    const existing = await zite.staffUsers.findAll({ limit: 1, fields: ['username'] });
    if (existing.records.length) fail('FORBIDDEN', 'راه‌اندازی اولیه قبلاً انجام شده است.');
    if ((await sha256(input.setupCode)) !== (await sha256(process.env.ZITE_SETUP_CODE))) fail('FORBIDDEN', 'کد راه‌اندازی صحیح نیست.');
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(username)) fail('BAD_REQUEST', 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه و خط تیره باشد.');
    const created = await db.staffUsers.create({ record: { username, fullName: input.fullName, passwordHash: await hashPassword(input.password), role: 'SuperAdmin', status: 'Active' } });
    await audit({ type: 'System', id: '', label: 'setup' }, 'staff.bootstrap', 'StaffUser', created.id, { username });
    return { ok: true };
  },
});
