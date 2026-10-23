import { eq, sql } from 'drizzle-orm';
import type { NotificationEvent } from '@food/shared';
import { accounts, employees, notificationOutbox, notificationReads, notifications, students } from '../db/schema/index.js';
import type { ServiceDeps, Tx } from '../types.js';
import { rawSql } from '../db/raw.js';

/**
 * اعلان‌ها.
 *
 *  - اعلان درون‌برنامه‌ای در `notifications` (عمومی یا برای یک حساب/کارکنان).
 *  - پیامک از طریق صف `notification_outbox` و worker ارسال می‌شود؛
 *    **پس از commit** تراکنش اصلی و بدون بلوکه کردن پاسخ کاربر.
 *  - اگر شمارهٔ موبایل موجود نباشد، فقط اعلان درون‌برنامه‌ای ثبت می‌شود.
 *    (جدول `students` ستون موبایل ندارد؛ این محدودیت در docs/SECURITY.md و
 *    «اطلاعات موردنیاز از دانشگاه» ثبت شده است.)
 */

export type InAppNotificationInput = {
  title: string;
  body: string;
  event?: NotificationEvent | string;
  audience?: 'Broadcast' | 'Account' | 'Staff';
  accountId?: string | null;
  staffUserId?: string | null;
  createdBy?: string | null;
};

export async function createNotification(target: Tx | ServiceDeps['db'], input: InAppNotificationInput): Promise<string> {
  const audience = input.audience ?? (input.accountId ? 'Account' : input.staffUserId ? 'Staff' : 'Broadcast');
  const [row] = await target
    .insert(notifications)
    .values({
      title: input.title.slice(0, 200),
      body: input.body,
      audience,
      accountId: audience === 'Account' ? (input.accountId ?? null) : null,
      staffUserId: audience === 'Staff' ? (input.staffUserId ?? null) : null,
      event: input.event ? String(input.event).slice(0, 60) : null,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: notifications.id });
  return row!.id;
}

/** افزودن پیامک به صف (فقط اگر مقصد داشته باشد). */
export async function queueSms(
  target: Tx | ServiceDeps['db'],
  input: { recipient: string | null | undefined; message: string; notificationId?: string | null; accountId?: string | null },
): Promise<boolean> {
  const recipient = String(input.recipient ?? '').replace(/\D/g, '');
  if (!recipient) return false;
  await target.insert(notificationOutbox).values({
    notificationId: input.notificationId ?? null,
    recipient: recipient.slice(0, 20),
    accountId: input.accountId ?? null,
    message: input.message.slice(0, 500),
    status: 'Queued',
    attempts: 0,
    nextAttemptAt: new Date(),
  });
  return true;
}

/** شمارهٔ موبایل کارمند (در صورت وجود). */
export async function employeeMobile(target: Tx | ServiceDeps['db'], employeeId: string): Promise<string | null> {
  const rows = await target.select({ mobile: employees.mobile }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  return rows[0]?.mobile ?? null;
}

export type NotificationView = {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
  personal: boolean;
  read: boolean;
};

/** اعلان‌های یک حساب (عمومی + اختصاصی) با وضعیت خوانده‌شده. */
export async function listNotificationsForAccount(
  target: Tx | ServiceDeps['db'],
  accountId: string,
  limit = 100,
): Promise<NotificationView[]> {
  const rows = await target.execute(
    sql`
      SELECT n.id, n.title, n.body, n.created_at AS "createdAt", n.audience,
             EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.subject_type='Account' AND r.subject_id = ${accountId}) AS read
      FROM notifications n
      WHERE n.audience = 'Broadcast' OR (n.audience = 'Account' AND n.account_id = ${accountId})
      ORDER BY n.created_at DESC
      LIMIT ${limit}`,
  );
  return ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt)),
    personal: String(r.audience) === 'Account',
    read: Boolean(r.read),
  }));
}

/** اعلان‌های یک کاربر کارکنان (عمومی + اختصاصی). */
export async function listNotificationsForStaff(target: Tx | ServiceDeps['db'], staffId: string, limit = 100): Promise<NotificationView[]> {
  const rows = await target.execute(
    sql`
      SELECT n.id, n.title, n.body, n.created_at AS "createdAt", n.audience,
             EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.subject_type='Staff' AND r.subject_id = ${staffId}) AS read
      FROM notifications n
      WHERE n.audience = 'Broadcast' OR (n.audience = 'Staff' AND n.staff_user_id = ${staffId})
      ORDER BY n.created_at DESC
      LIMIT ${limit}`,
  );
  return ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []).map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt)),
    personal: String(r.audience) === 'Staff',
    read: Boolean(r.read),
  }));
}

/** علامت‌گذاری به‌عنوان خوانده‌شده (فقط اعلان‌های قابل مشاهدهٔ همان سوژه). */
export async function markNotificationsRead(
  target: Tx | ServiceDeps['db'],
  subject: { type: 'Account' | 'Staff'; id: string },
  notificationIds?: string[],
): Promise<number> {
  const col = subject.type === 'Account' ? 'account_id' : 'staff_user_id';
  const visible = await target.execute(
    notificationIds && notificationIds.length > 0
      ? rawSql(
          `SELECT id FROM notifications WHERE id = ANY($1::uuid[]) AND (audience='Broadcast' OR (audience=$2 AND ${col} = $3::uuid))`,
          [notificationIds, subject.type, subject.id],
        )
      : rawSql(`SELECT id FROM notifications WHERE (audience='Broadcast' OR (audience=$1 AND ${col} = $2::uuid))`, [
          subject.type,
          subject.id,
        ]),
  );
  const ids = ((visible as unknown as { rows: { id: string }[] }).rows ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;

  await target
    .insert(notificationReads)
    .values(ids.map((id) => ({ notificationId: id, subjectType: subject.type, subjectId: subject.id })))
    .onConflictDoNothing();
  return ids.length;
}

/** اعلان هشدار به همهٔ مدیران ارشد (مثلاً `NeedsReview` یا ناسازگاری دفتر کل). */
export async function alertSuperAdmins(deps: ServiceDeps, input: { title: string; body: string; event?: string }): Promise<number> {
  return alertStaffByRoles(deps, ['SuperAdmin'], input);
}

/** اعلان هشدار به امور مالی و مدیران ارشد (برای پرداخت‌های `NeedsReview`). */
export async function alertFinanceAndAdmins(deps: ServiceDeps, input: { title: string; body: string; event?: string }): Promise<number> {
  return alertStaffByRoles(deps, ['Finance', 'SuperAdmin'], input);
}

async function alertStaffByRoles(
  deps: ServiceDeps,
  roles: string[],
  input: { title: string; body: string; event?: string },
): Promise<number> {
  const rows = await deps.db.execute(rawSql(`SELECT id FROM staff_users WHERE role = ANY($1::text[]) AND status = 'Active'`, [roles]));
  const ids = ((rows as unknown as { rows: { id: string }[] }).rows ?? []).map((r) => r.id);
  for (const id of ids) {
    await createNotification(deps.db, {
      title: input.title,
      body: input.body,
      audience: 'Staff',
      staffUserId: id,
      event: input.event ?? 'system.alert',
    });
  }
  return ids.length;
}

/** جست‌وجوی حساب برای اعلان اختصاصی (بر اساس شمارهٔ دانشجویی یا نام کاربری). */
export async function findAccountForNotification(
  target: Tx | ServiceDeps['db'],
  identifier: string,
): Promise<{ accountId: string; label: string; kind: 'Student' | 'Employee' } | null> {
  const normalized = String(identifier ?? '').trim();
  if (!normalized) return null;
  const student = await target
    .select({ accountId: accounts.id, label: students.studentNumber })
    .from(accounts)
    .innerJoin(students, eq(students.id, accounts.studentId))
    .where(eq(students.studentNumber, normalized.replace(/\D/g, '')))
    .limit(1);
  if (student[0]) return { accountId: student[0].accountId, label: student[0].label, kind: 'Student' };

  const employee = await target
    .select({ accountId: accounts.id, label: employees.username })
    .from(accounts)
    .innerJoin(employees, eq(employees.id, accounts.employeeId))
    .where(eq(employees.username, normalized.toLowerCase()))
    .limit(1);
  if (employee[0]) return { accountId: employee[0].accountId, label: employee[0].label, kind: 'Employee' };
  return null;
}

export const unreadCountFor = async (
  target: Tx | ServiceDeps['db'],
  subject: { type: 'Account' | 'Staff'; id: string },
): Promise<number> => {
  const list =
    subject.type === 'Account'
      ? await listNotificationsForAccount(target, subject.id, 100)
      : await listNotificationsForStaff(target, subject.id, 100);
  return list.filter((n) => !n.read).length;
};
