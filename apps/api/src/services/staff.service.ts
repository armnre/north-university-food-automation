import { sql } from 'drizzle-orm';
import {
  canManageStaffRole,
  isStrongEnoughPassword,
  normalizeUsername,
  ROLE_LEVEL,
  STAFF_ROLES,
  validateUsername,
  type StaffRole,
} from '@food/shared';
import { staffUsers } from '../db/schema/index.js';
import { hashPassword, randomCode } from '../lib/crypto.js';
import { AppError, fail } from '../lib/errors.js';
import type { Actor, AuthContext, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { revokeAllSessionsForSubject } from './session.service.js';
import { rawSql } from '../db/raw.js';

/**
 * مدیریت کارکنان سامانه با سلسله‌مراتب سخت‌گیرانه:
 *  - `StudentAffairs` حساب کارکنان نمی‌سازد (فقط حساب‌های کارمند/مشتری سلف).
 *  - `NutritionManager` فقط `Operator` و `Contractor` سلف.
 *  - `SuperAdmin` همهٔ نقش‌ها به‌جز `SuperAdmin` (ساخت مدیر ارشد فقط با SETUP_CODE یا CLI).
 *  - هیچ نقشی حساب هم‌سطح یا بالاتر را نمی‌سازد/ویرایش نمی‌کند.
 */

export type StaffListRow = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  status: string;
  contractorId: string | null;
  contractorName: string | null;
  cafeteriaId: string | null;
  cafeteriaName: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

export async function listStaff(
  deps: ServiceDeps,
  me: Extract<AuthContext, { kind: 'staff' }>,
): Promise<{ users: StaffListRow[]; manageableRoles: StaffRole[] }> {
  const manageableRoles = STAFF_ROLES.filter((role) => canManageStaffRole(me.role, role));
  const visibleRoles = me.role === 'SuperAdmin' ? STAFF_ROLES : manageableRoles;

  const rows = await deps.db.execute(
    rawSql(
      `SELECT u.id, u.username, u.full_name AS "fullName", u.role, u.status, u.contractor_id AS "contractorId",
              u.cafeteria_id AS "cafeteriaId", u.must_change_password AS "mustChangePassword",
              u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
              c.name AS "contractorName", cf.name AS "cafeteriaName"
       FROM staff_users u
       LEFT JOIN contractors c ON c.id = u.contractor_id
       LEFT JOIN cafeterias cf ON cf.id = u.cafeteria_id
       WHERE u.deleted_at IS NULL AND u.role = ANY($1::text[])
       ORDER BY u.username`,
      [visibleRoles as string[]],
    ),
  );

  return {
    users: (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      username: String(row.username ?? ''),
      fullName: String(row.fullName ?? ''),
      role: String(row.role ?? ''),
      status: String(row.status ?? ''),
      contractorId: row.contractorId == null ? null : String(row.contractorId),
      contractorName: row.contractorName == null ? null : String(row.contractorName),
      cafeteriaId: row.cafeteriaId == null ? null : String(row.cafeteriaId),
      cafeteriaName: row.cafeteriaName == null ? null : String(row.cafeteriaName),
      mustChangePassword: Boolean(row.mustChangePassword),
      lastLoginAt: row.lastLoginAt ? new Date(String(row.lastLoginAt)).toISOString() : null,
      createdAt: new Date(String(row.createdAt)).toISOString(),
    })),
    manageableRoles,
  };
}

export type StaffUpsertInput = {
  id?: string;
  username: string;
  fullName: string;
  role: StaffRole;
  status: 'Active' | 'Disabled';
  contractorId?: string | null;
  cafeteriaId?: string | null;
  password?: string;
  mustChangePassword?: boolean;
};

export async function saveStaff(
  deps: ServiceDeps,
  input: { data: StaffUpsertInput; me: Extract<AuthContext, { kind: 'staff' }>; actor: Actor; ip: string },
): Promise<{ id: string }> {
  const { data, me, actor, ip } = input;

  // سلسله‌مراتب: ساخت/ویرایش نقش هم‌سطح یا بالاتر ممنوع
  if (!canManageStaffRole(me.role, data.role)) {
    throw new AppError('FORBIDDEN', 'شما اجازهٔ ساخت یا ویرایش حساب این نقش را ندارید.');
  }
  if (data.role === 'SuperAdmin') {
    throw new AppError('FORBIDDEN', 'ساخت حساب مدیر ارشد فقط با کد راه‌اندازی یا دستور `npm run create-admin` ممکن است.');
  }

  const username = normalizeUsername(data.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new AppError('VALIDATION', usernameError);

  if (data.role === 'Operator' && !data.cafeteriaId) {
    throw new AppError('VALIDATION', 'برای اپراتور سلف، انتخاب سلف الزامی است.');
  }
  if (data.role === 'Contractor' && !data.contractorId) {
    throw new AppError('VALIDATION', 'برای حساب پیمانکار، انتخاب پیمانکار الزامی است.');
  }

  return deps.db.transaction(async (tx) => {
    if (data.id) {
      const existing = await tx
        .select()
        .from(staffUsers)
        .where(sql`${staffUsers.id} = ${data.id}`)
        .limit(1);
      const target = existing[0];
      if (!target) fail('NOT_FOUND', 'کاربر یافت نشد.');
      if (!canManageStaffRole(me.role, target.role as StaffRole)) {
        throw new AppError('FORBIDDEN', 'شما اجازهٔ ویرایش این حساب را ندارید.');
      }
      if (ROLE_LEVEL[target.role as StaffRole] >= ROLE_LEVEL[me.role]) {
        throw new AppError('FORBIDDEN', 'ویرایش حساب هم‌سطح یا بالاتر مجاز نیست.');
      }

      let passwordHash: string | undefined;
      if (data.password) {
        if (!isStrongEnoughPassword(data.password, username)) {
          throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد و با نام کاربری یکسان نباشد.');
        }
        passwordHash = await hashPassword(data.password);
      }

      await tx
        .update(staffUsers)
        .set({
          username,
          fullName: data.fullName.trim(),
          role: data.role,
          status: data.status,
          contractorId: data.contractorId ?? null,
          cafeteriaId: data.cafeteriaId ?? null,
          ...(passwordHash ? { passwordHash, passwordChangedAt: new Date(), mustChangePassword: data.mustChangePassword ?? true } : {}),
          ...(data.mustChangePassword == null ? {} : { mustChangePassword: data.mustChangePassword }),
        })
        .where(sql`${staffUsers.id} = ${data.id}`);

      if (data.status === 'Disabled' || passwordHash) {
        await revokeAllSessionsForSubject(tx, 'Staff', data.id, data.status === 'Disabled' ? 'disabled' : 'password_reset');
      }

      await writeAudit(tx, {
        actor,
        action: 'staff.update',
        targetType: 'StaffUser',
        targetId: data.id,
        details: {
          fromRole: target.role,
          toRole: data.role,
          fromStatus: target.status,
          toStatus: data.status,
          passwordChanged: Boolean(passwordHash),
        },
        ip,
      });
      return { id: data.id };
    }

    if (!data.password) throw new AppError('VALIDATION', 'برای کاربر جدید رمز عبور الزامی است.');
    if (!isStrongEnoughPassword(data.password, username)) {
      throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد و با نام کاربری یکسان نباشد.');
    }

    const [created] = await tx
      .insert(staffUsers)
      .values({
        username,
        fullName: data.fullName.trim(),
        role: data.role,
        status: data.status,
        contractorId: data.contractorId ?? null,
        cafeteriaId: data.cafeteriaId ?? null,
        passwordHash: await hashPassword(data.password),
        mustChangePassword: data.mustChangePassword ?? true,
        createdBy: me.staffId,
        passwordChangedAt: new Date(),
      })
      .onConflictDoNothing({ target: staffUsers.username })
      .returning({ id: staffUsers.id });

    if (!created) throw new AppError('CONFLICT', 'این نام کاربری قبلاً ثبت شده است.');

    await writeAudit(tx, {
      actor,
      action: 'staff.create',
      targetType: 'StaffUser',
      targetId: created.id,
      details: { username, role: data.role, status: data.status },
      ip,
    });
    return { id: created.id };
  });
}

/** ریست رمز عبور کارکنان + ابطال همهٔ نشست‌ها. */
export async function resetStaffPassword(
  deps: ServiceDeps,
  input: {
    id: string;
    newPassword?: string;
    mustChangePassword?: boolean;
    me: Extract<AuthContext, { kind: 'staff' }>;
    actor: Actor;
    ip: string;
  },
): Promise<{ temporaryPassword: string | null; sessionsRevoked: number }> {
  const temporaryPassword = input.newPassword ?? `${randomCode(6)}-${randomCode(6)}`;
  if (!isStrongEnoughPassword(temporaryPassword)) {
    throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.');
  }

  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(staffUsers)
      .where(sql`${staffUsers.id} = ${input.id}`)
      .limit(1);
    const target = rows[0];
    if (!target) fail('NOT_FOUND', 'کاربر یافت نشد.');
    if (!canManageStaffRole(input.me.role, target.role as StaffRole)) {
      throw new AppError('FORBIDDEN', 'شما اجازهٔ ریست رمز این حساب را ندارید.');
    }

    await tx
      .update(staffUsers)
      .set({
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: input.mustChangePassword ?? true,
        passwordChangedAt: new Date(),
      })
      .where(sql`${staffUsers.id} = ${input.id}`);

    const revoked = await revokeAllSessionsForSubject(tx, 'Staff', input.id, 'password_reset');
    await writeAudit(tx, {
      actor: input.actor,
      action: 'staff.password_reset',
      targetType: 'StaffUser',
      targetId: input.id,
      details: { sessionsRevoked: revoked },
      ip: input.ip,
    });
    return { temporaryPassword: input.newPassword ? null : temporaryPassword, sessionsRevoked: revoked };
  });
}

/** ساخت مدیر ارشد از خط فرمان (`npm run create-admin`). */
export async function createStaffFromCli(
  deps: ServiceDeps,
  input: {
    username: string;
    fullName: string;
    role: StaffRole;
    password: string;
    cafeteriaId?: string | null;
    contractorId?: string | null;
  },
): Promise<{ id: string }> {
  const username = normalizeUsername(input.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new AppError('VALIDATION', usernameError);
  if (!isStrongEnoughPassword(input.password, username)) {
    throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد و با نام کاربری یکسان نباشد.');
  }
  const [created] = await deps.db
    .insert(staffUsers)
    .values({
      username,
      fullName: input.fullName.trim(),
      role: input.role,
      status: 'Active',
      passwordHash: await hashPassword(input.password),
      mustChangePassword: false,
      cafeteriaId: input.cafeteriaId ?? null,
      contractorId: input.contractorId ?? null,
      passwordChangedAt: new Date(),
    })
    .onConflictDoNothing({ target: staffUsers.username })
    .returning({ id: staffUsers.id });
  if (!created) throw new AppError('CONFLICT', 'این نام کاربری قبلاً ثبت شده است.');
  await writeAudit(deps.db, {
    actor: { type: 'System', id: '', label: 'cli' },
    action: 'staff.create',
    targetType: 'StaffUser',
    targetId: created.id,
    details: { username, role: input.role, via: 'cli' },
  });
  return { id: created.id };
}
