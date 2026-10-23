import { sql } from 'drizzle-orm';
import { isStrongEnoughPassword, maskNationalId, normalizeMobile, normalizeUsername, validateUsername } from '@food/shared';
import { accounts, employees } from '../db/schema/index.js';
import { hashPassword, randomCode } from '../lib/crypto.js';
import { AppError, fail } from '../lib/errors.js';
import type { Actor, AuthContext, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { ensureEmployeeAccount } from './account.service.js';
import { revokeAllSessionsForSubject } from './session.service.js';
import { rawSql } from '../db/raw.js';

/**
 * کارمندان / هیئت‌علمی / پیمانکاران دانشگاه — مشتریان سلف با ورود نام‌کاربری+رمز
 * و قیمت جدا برای هر گروه مشتری.
 *
 * مدیریت توسط `StudentAffairs` و `SuperAdmin` (مجوز `employees`).
 */

export type EmployeeListFilters = { search?: string; customerGroup?: string; status?: string; offset?: number; limit?: number };

export async function listEmployees(deps: ServiceDeps, filters: EmployeeListFilters) {
  const params: unknown[] = [];
  const where: string[] = ['e.deleted_at IS NULL'];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    where.push(
      `(e.username ILIKE ${p(like)} OR e.full_name ILIKE ${p(like)} OR e.department ILIKE ${p(like)} OR e.personnel_code ILIKE ${p(like)})`,
    );
  }
  if (filters.customerGroup) where.push(`e.customer_group = ${p(filters.customerGroup)}`);
  if (filters.status) where.push(`e.status = ${p(filters.status)}`);

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const rows = await deps.db.execute(
    rawSql(
      `SELECT e.id, e.username, e.full_name AS "fullName", e.customer_group AS "customerGroup", e.department,
              e.mobile, e.personnel_code AS "personnelCode", e.national_id_last4 AS "nationalIdLast4", e.status,
              e.must_change_password AS "mustChangePassword", e.last_login_at AS "lastLoginAt", e.created_at AS "createdAt",
              COALESCE(a.balance_rial,0)::text AS "balanceRial"
       FROM employees e LEFT JOIN accounts a ON a.employee_id = e.id
       WHERE ${where.join(' AND ')}
       ORDER BY e.full_name
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );
  const countResult = await deps.db.execute(rawSql(`SELECT COUNT(*)::int AS n FROM employees e WHERE ${where.join(' AND ')}`, params));

  return {
    total: Number(((countResult as unknown as { rows: { n: number }[] }).rows ?? [])[0]?.n ?? 0),
    employees: (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      username: String(row.username ?? ''),
      fullName: String(row.fullName ?? ''),
      customerGroup: String(row.customerGroup ?? ''),
      department: String(row.department ?? ''),
      mobile: row.mobile == null ? null : String(row.mobile),
      personnelCode: row.personnelCode == null ? null : String(row.personnelCode),
      nationalIdMasked: maskNationalId(row.nationalIdLast4 == null ? '' : String(row.nationalIdLast4)),
      status: String(row.status ?? ''),
      balanceRial: Number(row.balanceRial ?? 0),
      mustChangePassword: Boolean(row.mustChangePassword),
      lastLoginAt: row.lastLoginAt ? new Date(String(row.lastLoginAt)).toISOString() : null,
      createdAt: new Date(String(row.createdAt)).toISOString(),
    })),
  };
}

export type EmployeeUpsertInput = {
  id?: string;
  username: string;
  fullName: string;
  customerGroup: 'Employee' | 'Faculty' | 'Contractor';
  department?: string;
  mobile?: string;
  personnelCode?: string;
  nationalIdLast4?: string;
  status: 'Active' | 'Disabled';
  password?: string;
  mustChangePassword?: boolean;
};

export async function saveEmployee(
  deps: ServiceDeps,
  input: { data: EmployeeUpsertInput; me: Extract<AuthContext, { kind: 'staff' }>; actor: Actor; ip: string },
): Promise<{ id: string; temporaryPassword: string | null }> {
  const { data, me, actor, ip } = input;
  const username = normalizeUsername(data.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new AppError('VALIDATION', usernameError);
  if (data.mobile && !/^0?9\d{9}$/.test(normalizeMobile(data.mobile).replace(/\D/g, ''))) {
    throw new AppError('VALIDATION', 'شمارهٔ موبایل معتبر نیست.');
  }
  if (data.nationalIdLast4 && !/^\d{4}$/.test(data.nationalIdLast4)) {
    throw new AppError('VALIDATION', 'فقط ۴ رقم آخر کد ملی ذخیره می‌شود.');
  }

  return deps.db.transaction(async (tx) => {
    if (data.id) {
      const rows = await tx
        .select()
        .from(employees)
        .where(sql`${employees.id} = ${data.id}`)
        .limit(1);
      if (!rows[0]) fail('NOT_FOUND', 'کارمند یافت نشد.');
      await tx
        .update(employees)
        .set({
          username,
          fullName: data.fullName.trim(),
          customerGroup: data.customerGroup,
          department: data.department?.trim() ?? '',
          mobile: data.mobile ? normalizeMobile(data.mobile) : null,
          personnelCode: data.personnelCode?.trim() || null,
          nationalIdLast4: data.nationalIdLast4 ?? null,
          status: data.status,
          ...(data.mustChangePassword == null ? {} : { mustChangePassword: data.mustChangePassword }),
        })
        .where(sql`${employees.id} = ${data.id}`);

      if (data.status === 'Disabled') {
        await tx
          .update(accounts)
          .set({ isActive: false })
          .where(sql`${accounts.employeeId} = ${data.id}`);
        await revokeAllSessionsForSubject(tx, 'Employee', data.id, 'disabled');
      } else {
        await tx
          .update(accounts)
          .set({ isActive: true })
          .where(sql`${accounts.employeeId} = ${data.id}`);
        await ensureEmployeeAccount(tx, data.id, data.customerGroup);
      }

      await writeAudit(tx, {
        actor,
        action: 'employee.update',
        targetType: 'Employee',
        targetId: data.id,
        details: { username, customerGroup: data.customerGroup, status: data.status },
        ip,
      });
      return { id: data.id, temporaryPassword: null };
    }

    const password = data.password ?? `${randomCode(5)}-${randomCode(5)}`;
    if (!isStrongEnoughPassword(password, username)) {
      throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد و با نام کاربری یکسان نباشد.');
    }

    const [created] = await tx
      .insert(employees)
      .values({
        username,
        fullName: data.fullName.trim(),
        customerGroup: data.customerGroup,
        department: data.department?.trim() ?? '',
        mobile: data.mobile ? normalizeMobile(data.mobile) : null,
        personnelCode: data.personnelCode?.trim() || null,
        nationalIdLast4: data.nationalIdLast4 ?? null,
        status: data.status,
        passwordHash: await hashPassword(password),
        mustChangePassword: data.mustChangePassword ?? true,
        createdBy: me.staffId,
        passwordChangedAt: new Date(),
      })
      .onConflictDoNothing({ target: employees.username })
      .returning({ id: employees.id });
    if (!created) throw new AppError('CONFLICT', 'این نام کاربری قبلاً ثبت شده است.');

    await ensureEmployeeAccount(tx, created.id, data.customerGroup);
    await writeAudit(tx, {
      actor,
      action: 'employee.create',
      targetType: 'Employee',
      targetId: created.id,
      details: { username, customerGroup: data.customerGroup },
      ip,
    });

    return { id: created.id, temporaryPassword: data.password ? null : password };
  });
}

/** ریست رمز عبور کارمند + ابطال نشست‌ها. */
export async function resetEmployeePassword(
  deps: ServiceDeps,
  input: { id: string; newPassword?: string; actor: Actor; ip: string },
): Promise<{ temporaryPassword: string; sessionsRevoked: number }> {
  const temporaryPassword = input.newPassword ?? `${randomCode(5)}-${randomCode(5)}`;
  if (!isStrongEnoughPassword(temporaryPassword)) throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.');

  const rows = await deps.db
    .select({ id: employees.id, username: employees.username })
    .from(employees)
    .where(sql`${employees.id} = ${input.id}`)
    .limit(1);
  if (!rows[0]) fail('NOT_FOUND', 'کارمند یافت نشد.');

  await deps.db
    .update(employees)
    .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, passwordChangedAt: new Date() })
    .where(sql`${employees.id} = ${input.id}`);
  const revoked = await revokeAllSessionsForSubject(deps.db, 'Employee', input.id, 'password_reset');
  await writeAudit(deps.db, {
    actor: input.actor,
    action: 'employee.password_reset',
    targetType: 'Employee',
    targetId: input.id,
    details: { sessionsRevoked: revoked },
    ip: input.ip,
  });
  return { temporaryPassword, sessionsRevoked: revoked };
}

export type BulkEmployeeRow = {
  username: string;
  fullName: string;
  customerGroup: 'Employee' | 'Faculty' | 'Contractor';
  department?: string;
  mobile?: string;
};

/**
 * ساخت گروهی کارمندان (حداکثر ۳۰۰ ردیف).
 * رمزهای تصادفی تولید می‌شوند و **فقط یک بار** در فایل اعتبارنامه برگردانده می‌شوند؛
 * هیچ رمزی در دیتابیس به‌صورت خام ذخیره نمی‌شود.
 */
export async function bulkCreateEmployees(
  deps: ServiceDeps,
  input: { rows: BulkEmployeeRow[]; actor: Actor; staffId: string; ip: string },
): Promise<{ created: number; skipped: number; credentials: { username: string; fullName: string; password: string }[] }> {
  if (input.rows.length > 300) throw new AppError('VALIDATION', 'حداکثر ۳۰۰ ردیف در هر بار واردسازی کارمندان مجاز است.');
  const credentials: { username: string; fullName: string; password: string }[] = [];
  let created = 0;
  let skipped = 0;

  await deps.db.transaction(async (tx) => {
    for (const row of input.rows) {
      const username = normalizeUsername(row.username);
      if (validateUsername(username)) {
        skipped += 1;
        continue;
      }
      const password = `${randomCode(5)}-${randomCode(5)}`;
      const [inserted] = await tx
        .insert(employees)
        .values({
          username,
          fullName:
            String(row.fullName ?? '')
              .trim()
              .slice(0, 200) || username,
          customerGroup: row.customerGroup,
          department: String(row.department ?? '')
            .trim()
            .slice(0, 200),
          mobile: row.mobile ? normalizeMobile(row.mobile) : null,
          passwordHash: await hashPassword(password),
          mustChangePassword: true,
          createdBy: input.staffId,
          status: 'Active',
          passwordChangedAt: new Date(),
        })
        .onConflictDoNothing({ target: employees.username })
        .returning({ id: employees.id, username: employees.username, fullName: employees.fullName });
      if (!inserted) {
        skipped += 1;
        continue;
      }
      await ensureEmployeeAccount(tx, inserted.id, row.customerGroup);
      credentials.push({ username: inserted.username, fullName: inserted.fullName, password });
      created += 1;
    }
    await writeAudit(tx, {
      actor: input.actor,
      action: 'employee.bulk_create',
      targetType: 'Employee',
      targetId: '',
      details: { created, skipped },
      ip: input.ip,
    });
  });

  return { created, skipped, credentials };
}
