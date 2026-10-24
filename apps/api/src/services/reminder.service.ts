import { addDays, formatFaTime, mealSlotLabel, tehranDateTimeToUtc, tehranToday } from '@food/shared';
import { rawSql } from '../db/raw.js';
import type { ServiceDeps } from '../types.js';
import { createNotification, queueSms } from './notification.service.js';
import { getSettings } from './settings.service.js';

/**
 * ارسال یادآوری وعده (`send-meal-reminders`).
 *
 * قواعد:
 *  - فقط رزروهای در وضعیت `Reserved` که هنوز رکوردی در `reservation_reminders` ندارند.
 *  - محاسبهٔ زمان شروع وعده دقیقاً بر مبنای منطقهٔ زمانی `Asia/Tehran` (`tehranDateTimeToUtc`).
 *  - فقط زمانی ارسال می‌شود که تا شروع وعده بیش از ۰ ثانیه و حداکثر `reminderHoursBeforeMeal` ساعت مانده باشد.
 *  - هم اعلان درون‌برنامه‌ای ثبت می‌شود و هم (در صورت وجود شمارهٔ موبایل معتبر) پیامک در `notification_outbox` صف می‌شود.
 *  - به واسطهٔ قید یکتای `reservation_reminders.reservation_id` و `ON CONFLICT DO NOTHING` کاملاً idempotent است.
 */

export type MealReminderRunResult = {
  checked: number;
  sent: number;
  smsQueued: number;
  reminderHoursBeforeMeal: number;
};

type CandidateRow = {
  reservationId: string;
  code: string;
  accountId: string;
  serviceDate: string;
  mealSlotCode: string;
  mealSlotTitle: string;
  slotStartTime: string;
  slotEndTime: string;
  foodName: string;
  cafeteriaName: string;
  mobile: string | null;
};

export async function sendMealReminders(deps: ServiceDeps, now = new Date()): Promise<MealReminderRunResult> {
  const settings = await getSettings(deps);
  const hours = settings.reminderHoursBeforeMeal;
  if (hours <= 0) {
    return { checked: 0, sent: 0, smsQueued: 0, reminderHoursBeforeMeal: hours };
  }

  const todayFa = tehranToday(now);
  const fromDate = addDays(todayFa, -1);
  const toDate = addDays(todayFa, 2);

  const res = await deps.db.execute(
    rawSql(
      `SELECT r.id AS "reservationId",
              r.code,
              r.account_id AS "accountId",
              r.service_date::text AS "serviceDate",
              ms.code AS "mealSlotCode",
              ms.title AS "mealSlotTitle",
              ms.start_time::text AS "slotStartTime",
              ms.end_time::text AS "slotEndTime",
              f.name AS "foodName",
              c.name AS "cafeteriaName",
              e.mobile AS "mobile"
       FROM reservations r
       JOIN meal_slots ms ON ms.id = r.meal_slot_id
       JOIN meal_offerings o ON o.id = r.offering_id
       JOIN foods f ON f.id = o.food_id
       JOIN cafeterias c ON c.id = r.cafeteria_id
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE r.status = 'Reserved'
         AND r.service_date >= $1::date
         AND r.service_date <= $2::date
         AND NOT EXISTS (
           SELECT 1 FROM reservation_reminders rr WHERE rr.reservation_id = r.id
         )
       ORDER BY r.service_date ASC, ms.sort_order ASC, r.created_at ASC
       LIMIT 1000`,
      [fromDate, toDate],
    ),
  );

  const candidates = (((res as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map(
    (r): CandidateRow => ({
      reservationId: String(r.reservationId),
      code: String(r.code ?? ''),
      accountId: String(r.accountId),
      serviceDate: String(r.serviceDate ?? '').slice(0, 10),
      mealSlotCode: String(r.mealSlotCode ?? ''),
      mealSlotTitle: String(r.mealSlotTitle ?? ''),
      slotStartTime: String(r.slotStartTime ?? '').slice(0, 5),
      slotEndTime: String(r.slotEndTime ?? '').slice(0, 5),
      foodName: String(r.foodName ?? ''),
      cafeteriaName: String(r.cafeteriaName ?? ''),
      mobile: r.mobile == null ? null : String(r.mobile),
    }),
  );

  const windowMs = hours * 3_600_000;
  const nowMs = now.getTime();
  let sent = 0;
  let smsQueued = 0;

  for (const row of candidates) {
    if (!/^\d{2}:\d{2}$/.test(row.slotStartTime)) continue;
    const mealStartUtc = tehranDateTimeToUtc(row.serviceDate, row.slotStartTime);
    const diffMs = mealStartUtc.getTime() - nowMs;

    // فقط زمانی که وعده هنوز شروع نشده (diffMs > 0) و در بازهٔ یادآوری (diffMs <= windowMs) است
    if (diffMs <= 0 || diffMs > windowMs) continue;

    const cleanMobile = String(row.mobile ?? '').replace(/\D/g, '');
    const willQueueSms = cleanMobile.length > 0;
    const shortCode = row.code.replace(/^R-/, '');
    const slotLabel = row.mealSlotTitle || mealSlotLabel(row.mealSlotCode);
    const mealEndUtc = /^\d{2}:\d{2}$/.test(row.slotEndTime) ? tehranDateTimeToUtc(row.serviceDate, row.slotEndTime) : mealStartUtc;
    const timeRangeFa = `${formatFaTime(mealStartUtc)} تا ${formatFaTime(mealEndUtc)}`;
    const bodyText = `یادآوری تحویل وعدهٔ ${slotLabel} («${row.foodName}») در ${row.cafeteriaName} — بازهٔ تحویل: ساعت ${timeRangeFa}. کد بلیت: ${shortCode}`;

    const deliveredReminder = await deps.db.transaction(async (tx) => {
      const lockRes = await tx.execute(rawSql(`SELECT status FROM reservations WHERE id = $1::uuid FOR UPDATE`, [row.reservationId]));
      const currentStatus = ((lockRes as unknown as { rows: { status: string }[] }).rows ?? [])[0]?.status;
      if (currentStatus !== 'Reserved') {
        return { sent: false, sms: false };
      }

      const inserted = await tx.execute(
        rawSql(
          `INSERT INTO reservation_reminders (reservation_id, sent_at, sms_queued)
           VALUES ($1::uuid, $2::timestamptz, $3::boolean)
           ON CONFLICT (reservation_id) DO NOTHING
           RETURNING id`,
          [row.reservationId, now.toISOString(), willQueueSms],
        ),
      );
      const insertedRows = (inserted as unknown as { rows: { id: string }[] }).rows ?? [];
      if (insertedRows.length === 0) {
        return { sent: false, sms: false };
      }

      const notificationId = await createNotification(tx, {
        title: `یادآوری وعدهٔ ${slotLabel}`,
        body: bodyText,
        audience: 'Account',
        accountId: row.accountId,
        event: 'reservation.reminder',
      });

      let queued = false;
      if (willQueueSms) {
        queued = await queueSms(tx, {
          recipient: cleanMobile,
          message: bodyText,
          notificationId,
          accountId: row.accountId,
        });
      }

      return { sent: true, sms: queued };
    });

    if (deliveredReminder.sent) sent += 1;
    if (deliveredReminder.sms) smsQueued += 1;
  }

  return {
    checked: candidates.length,
    sent,
    smsQueued,
    reminderHoursBeforeMeal: hours,
  };
}
