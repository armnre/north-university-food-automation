import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, hashPassword, requireStaff, staffActor } from '../server/core';

export default createEndpoint({
  description: 'Creates or updates a staff user (role, status, scope, optional password reset)',
  inputSchema: z.object({
    token: z.string(),
    id: z.string().uuid().optional(),
    username: z.string().min(3).max(64),
    fullName: z.string().min(2).max(100),
    role: z.enum(['SuperAdmin', 'StudentAffairs', 'Contractor', 'Operator', 'Finance']),
    status: z.enum(['Active', 'Inactive']),
    password: z.string().max(200).optional(),
  }),
  outputSchema: z.object({ id: z.string() }),
  execute: async ({ input }) => {
    const actor = await requireStaff(input.token, 'users');
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(username)) fail('BAD_REQUEST', 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه و خط تیره باشد.');
    if (input.password && input.password.length < 10) fail('BAD_REQUEST', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.');
    const clash = await zite.staffUsers.findOne({ filters: { username } });
    if (clash && clash.id !== input.id) fail('CONFLICT', 'این نام کاربری قبلاً استفاده شده است.');
    if (input.id === actor.id && (input.status !== 'Active' || input.role !== actor.role)) fail('BAD_REQUEST', 'نمی‌توانید نقش یا وضعیت حساب خودتان را تغییر دهید.');

    const before = input.id ? await zite.staffUsers.findOne({ id: input.id }) : null;
    if (input.id && !before) fail('NOT_FOUND', 'کاربر یافت نشد.');
    const privileged = ['SuperAdmin', 'StudentAffairs'];
    if (actor.role !== 'SuperAdmin' && (privileged.includes(input.role) || privileged.includes(String(before?.role ?? ''))))
      fail('FORBIDDEN', 'فقط مدیر ارشد می‌تواند حساب مدیر ارشد یا معاونت دانشجویی را بسازد یا ویرایش کند.');

    const record: Record<string, unknown> = {
      username, fullName: input.fullName, role: input.role, status: input.status,
      contractor: null, cafeteria: null,
    };
    if (input.password) record.passwordHash = await hashPassword(input.password);

    if (input.id && before) {
      await db.staffUsers.update({ id: input.id, record });
      if (input.status !== 'Active' || input.password) {
        const sessions = await zite.sessions.findAll({ filters: { subjectId: input.id, revoked: false }, limit: 200 });
        for (const s of sessions.records) await db.sessions.update({ id: s.id, record: { revoked: true } });
      }
      await audit(staffActor(actor), 'staff.update', 'StaffUser', input.id, { username, fromRole: before.role, toRole: input.role, fromStatus: before.status, toStatus: input.status, passwordReset: !!input.password });
      return { id: input.id };
    }
    if (!input.password) fail('BAD_REQUEST', 'برای کاربر جدید رمز عبور الزامی است.');
    const created = await db.staffUsers.create({ record });
    await audit(staffActor(actor), 'staff.create', 'StaffUser', created.id, { username, role: input.role });
    return { id: created.id };
  },
});
