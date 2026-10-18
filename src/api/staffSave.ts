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
    contractorId: z.string().uuid().nullable(),
    cafeteriaId: z.string().uuid().nullable(),
    password: z.string().max(200).optional(),
    reason: z.string().min(3).max(500),
  }),
  outputSchema: z.object({ id: z.string() }),
  execute: async ({ input }) => {
    const actor = await requireStaff(input.token, 'users');
    const username = input.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(username)) fail('BAD_REQUEST', 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه و خط تیره باشد.');
    if (input.password && input.password.length < 10) fail('BAD_REQUEST', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.');
    if (input.role === 'Contractor' && !input.contractorId) fail('BAD_REQUEST', 'برای نقش پیمانکار، انتخاب پیمانکار الزامی است.');
    if (input.role === 'Operator' && !input.cafeteriaId) fail('BAD_REQUEST', 'برای اپراتور سلف، انتخاب سلف الزامی است.');
    const clash = await zite.staffUsers.findOne({ filters: { username } });
    if (clash && clash.id !== input.id) fail('CONFLICT', 'این نام کاربری قبلاً استفاده شده است.');
    if (input.id === actor.id && (input.status !== 'Active' || input.role !== 'SuperAdmin')) fail('BAD_REQUEST', 'نمی‌توانید نقش یا وضعیت حساب خودتان را تغییر دهید.');

    const record: Record<string, unknown> = {
      username, fullName: input.fullName, role: input.role, status: input.status,
      contractor: input.role === 'Contractor' && input.contractorId ? [input.contractorId] : null,
      cafeteria: input.role === 'Operator' && input.cafeteriaId ? [input.cafeteriaId] : null,
    };
    if (input.password) record.passwordHash = await hashPassword(input.password);

    if (input.id) {
      const before = await zite.staffUsers.findOne({ id: input.id });
      if (!before) fail('NOT_FOUND', 'کاربر یافت نشد.');
      await db.staffUsers.update({ id: input.id, record });
      if (input.status !== 'Active' || input.password) {
        // revoke live sessions of a disabled user or after password reset
        const sessions = await zite.sessions.findAll({ filters: { subjectId: input.id, revoked: false }, limit: 200 });
        for (const s of sessions.records) await db.sessions.update({ id: s.id, record: { revoked: true } });
      }
      await audit(staffActor(actor), 'staff.update', 'StaffUser', input.id, { username, fromRole: before.role, toRole: input.role, fromStatus: before.status, toStatus: input.status, passwordReset: !!input.password, reason: input.reason });
      return { id: input.id };
    }
    if (!input.password) fail('BAD_REQUEST', 'برای کاربر جدید رمز عبور الزامی است.');
    const created = await db.staffUsers.create({ record });
    await audit(staffActor(actor), 'staff.create', 'StaffUser', created.id, { username, role: input.role, reason: input.reason });
    return { id: created.id };
  },
});
