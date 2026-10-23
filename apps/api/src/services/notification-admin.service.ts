import { AppError } from '../lib/errors.js';
import type { Actor, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { createNotification, employeeMobile, findAccountForNotification, queueSms } from './notification.service.js';
import { rawSql } from '../db/raw.js';

/** ارسال اعلان توسط مدیر/معاونت (عمومی، یک حساب یا یک کاربر کارکنان). */

export type AdminNotifyInput = {
  title: string;
  body: string;
  audience: 'broadcast' | 'account' | 'staff';
  identifier?: string;
  staffUserId?: string;
  sendSms: boolean;
  actor: Actor;
  staffId: string;
  ip: string;
};

export async function sendAdminNotification(deps: ServiceDeps, input: AdminNotifyInput): Promise<{ id: string; recipients: number }> {
  if (input.audience === 'account') {
    const target = await findAccountForNotification(deps.db, input.identifier ?? '');
    if (!target) throw new AppError('NOT_FOUND', 'دانشجو یا کارمندی با این شناسه یافت نشد.');
    const id = await createNotification(deps.db, {
      title: input.title,
      body: input.body,
      audience: 'Account',
      accountId: target.accountId,
      event: 'system.alert',
      createdBy: input.staffId,
    });
    let smsQueued = false;
    if (input.sendSms) {
      const holder = await deps.db.execute(
        rawSql(`SELECT e.id FROM accounts a JOIN employees e ON e.id = a.employee_id WHERE a.id = $1`, [target.accountId]),
      );
      const employeeId = ((holder as unknown as { rows: { id: string }[] }).rows ?? [])[0]?.id ?? null;
      if (employeeId)
        smsQueued = await queueSms(deps.db, {
          recipient: await employeeMobile(deps.db, employeeId),
          message: `${input.title}: ${input.body}`,
          notificationId: id,
          accountId: target.accountId,
        });
    }
    await writeAudit(deps.db, {
      actor: input.actor,
      action: 'notification.send',
      targetType: 'Notification',
      targetId: id,
      details: { audience: 'account', recipient: target.label, smsQueued },
      ip: input.ip,
    });
    return { id, recipients: 1 };
  }

  if (input.audience === 'staff') {
    if (!input.staffUserId) throw new AppError('VALIDATION', 'کاربر کارکنان را مشخص کنید.');
    const id = await createNotification(deps.db, {
      title: input.title,
      body: input.body,
      audience: 'Staff',
      staffUserId: input.staffUserId,
      event: 'system.alert',
      createdBy: input.staffId,
    });
    await writeAudit(deps.db, {
      actor: input.actor,
      action: 'notification.send',
      targetType: 'Notification',
      targetId: id,
      details: { audience: 'staff' },
      ip: input.ip,
    });
    return { id, recipients: 1 };
  }

  const id = await createNotification(deps.db, {
    title: input.title,
    body: input.body,
    audience: 'Broadcast',
    event: 'system.alert',
    createdBy: input.staffId,
  });

  // صف پیامک فقط برای حساب‌هایی که شمارهٔ موبایل دارند (کارمندان)
  let smsQueued = 0;
  if (input.sendSms) {
    const rows = await deps.db.execute(
      rawSql(
        `SELECT a.id AS "accountId", e.mobile FROM accounts a JOIN employees e ON e.id = a.employee_id WHERE e.mobile IS NOT NULL AND e.status = 'Active' LIMIT 5000`,
      ),
    );
    for (const row of ((rows as unknown as { rows: { accountId: string; mobile: string }[] }).rows ?? []) as {
      accountId: string;
      mobile: string;
    }[]) {
      const queued = await queueSms(deps.db, {
        recipient: row.mobile,
        message: `${input.title}: ${input.body}`,
        notificationId: id,
        accountId: row.accountId,
      });
      if (queued) smsQueued += 1;
    }
  }

  await writeAudit(deps.db, {
    actor: input.actor,
    action: 'notification.send',
    targetType: 'Notification',
    targetId: id,
    details: { audience: 'broadcast', smsQueued },
    ip: input.ip,
  });
  return { id, recipients: smsQueued };
}

/** فهرست اعلان‌های ارسال‌شده برای مدیریت. */
export async function listAdminNotifications(deps: ServiceDeps, limit = 50) {
  const rows = await deps.db.execute(
    rawSql(
      `SELECT n.id, n.title, n.body, n.audience, n.created_at AS "createdAt",
              COALESCE(s.student_number, e.username) AS "recipientLabel",
              (SELECT o.status FROM notification_outbox o WHERE o.notification_id = n.id ORDER BY o.created_at DESC LIMIT 1) AS "smsStatus"
       FROM notifications n
       LEFT JOIN accounts a ON a.id = n.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       ORDER BY n.created_at DESC
       LIMIT $1`,
      [limit],
    ),
  );
  return {
    notifications: (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      audience: String(row.audience ?? ''),
      recipientLabel: row.recipientLabel == null ? null : String(row.recipientLabel),
      createdAt: new Date(String(row.createdAt)).toISOString(),
      smsStatus: row.smsStatus == null ? null : String(row.smsStatus),
    })),
  };
}
