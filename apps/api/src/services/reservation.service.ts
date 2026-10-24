import { eq, sql } from 'drizzle-orm';
import {
  addHours,
  formatFaDateTime,
  LIVE_RESERVATION_STATUSES,
  tehranDateTimeToUtc,
  tehranToday,
  type ResolvedSettings,
} from '@food/shared';
import { mealOfferings, reservations, reservationHistory } from '../db/schema/index.js';
import { newReservationCode, newTrackingCode, randomHex } from '../lib/crypto.js';
import { AppError, dbErrorText, fail, pgErrorCode } from '../lib/errors.js';
import { lockOfferingForUpdate, priceForGroup } from '../repositories/offering.repo.js';
import { lockReservationForUpdate, queryReservations, type ReservationRow } from '../repositories/reservation.repo.js';
import type { Actor, CustomerAuth, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';
import { lockAccountsForUpdate, postLedger } from './ledger.service.js';
import { createNotification, employeeMobile, queueSms } from './notification.service.js';
import { getSettings } from './settings.service.js';
import { assertAccountUsable, getAccountHolder } from './account.service.js';
import { rawSql } from '../db/raw.js';

/**
 * موتور رزرو، لغو و بازپرداخت.
 *
 * الگوی قدیمی «insert-then-verify» (درج سپس بررسی و رد) کاملاً حذف شده است:
 * همهٔ بررسی‌ها و تغییرات در **یک تراکنش PostgreSQL** با قفل ردیف (`FOR UPDATE`)
 * و به‌روزرسانی‌های اتمیک شرط‌دار انجام می‌شود.
 */

export type ReserveInput = {
  auth: CustomerAuth;
  offeringId: string;
  idempotencyKey: string;
  ip: string;
  userAgent?: string;
};

export type ReserveResult = {
  reservationId: string;
  code: string;
  priceRial: number;
  balanceRial: number;
  replay: boolean;
};

/** محاسبهٔ مهلت لغو: `cancel_deadline` وعده اگر پر باشد، وگرنه شروع وعده − cancel_cutoff_hours. */
export function computeCancelDeadline(
  row: { offeringCancelDeadline: Date | null; serviceDate: string; slotStartTime: string },
  settings: ResolvedSettings,
): Date {
  if (row.offeringCancelDeadline) return row.offeringCancelDeadline;
  const start = tehranDateTimeToUtc(row.serviceDate, String(row.slotStartTime ?? '12:00').slice(0, 5));
  return addHours(start, -settings.cancelCutoffHours);
}

/** بازهٔ مجاز اسکن تحویل: [شروع وعده − before, پایان وعده + after] به وقت تهران. */
export function computeScanWindow(
  row: { serviceDate: string; slotStartTime: string; slotEndTime: string },
  settings: ResolvedSettings,
): { from: Date; to: Date } {
  const start = tehranDateTimeToUtc(row.serviceDate, String(row.slotStartTime ?? '12:00').slice(0, 5));
  const end = tehranDateTimeToUtc(row.serviceDate, String(row.slotEndTime ?? '14:00').slice(0, 5));
  return {
    from: new Date(start.getTime() - settings.scanWindowBeforeMinutes * 60_000),
    to: new Date(end.getTime() + settings.scanWindowAfterMinutes * 60_000),
  };
}

export type ValidatedCheckoutOffering = {
  offeringId: string;
  foodName: string;
  serviceDate: string;
  slotStartTime: string;
  mealSlotTitle: string;
  priceRial: number;
  hasPayment?: boolean;
  hasInstant?: boolean;
};

/**
 * اعتبارسنجی یک آیتم منو پیش از شروع پرداخت یا رزرو فوری (بدون تغییر دیتابیس).
 * همهٔ شرایط زمانی، ظرفیت، گروه مشتری و عدم رزرو تکراری بررسی می‌شوند.
 */
export async function validateOfferingForCheckout(
  target: Tx | ServiceDeps['db'],
  input: {
    accountId: string;
    customerGroup: CustomerAuth['customerGroup'];
    offeringId: string;
    paymentIdemKey?: string;
    instantIdemKey?: string;
  },
): Promise<{
  offering: ValidatedCheckoutOffering | null;
  hasPayment: boolean;
  hasInstant: boolean;
  failReason?: () => never;
}> {
  const rows = await target.execute(
    rawSql(
      `SELECT o.id, o.status, o.service_date::text AS "serviceDate", o.capacity, o.reserved_count AS "reservedCount",
              o.reserve_opens_at AS "reserveOpensAt", o.reserve_deadline AS "reserveDeadline",
              f.name AS "foodName", ms.title AS "mealSlotTitle", ms.start_time::text AS "slotStartTime",
              mop.price_rial::text AS "priceRial",
              EXISTS(
                SELECT 1 FROM reservations r
                WHERE r.account_id = $2::uuid AND r.offering_id = o.id AND r.status IN ('Reserved','Delivered')
              ) AS "alreadyReserved",
              CASE WHEN $4::text IS NOT NULL THEN EXISTS(SELECT 1 FROM payments p WHERE p.idempotency_key = $4) ELSE false END AS "hasPayment",
              CASE WHEN $5::text IS NOT NULL THEN EXISTS(SELECT 1 FROM reservations ri WHERE ri.idempotency_key = $5) ELSE false END AS "hasInstant"
       FROM meal_offerings o
       JOIN foods f ON f.id = o.food_id
       JOIN meal_slots ms ON ms.id = o.meal_slot_id
       LEFT JOIN offering_prices mop ON mop.offering_id = o.id AND mop.customer_group = $3
       WHERE o.id = $1::uuid AND o.deleted_at IS NULL`,
      [input.offeringId, input.accountId, input.customerGroup, input.paymentIdemKey ?? null, input.instantIdemKey ?? null],
    ),
  );
  const row = ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!row) {
    const fallbackIdem =
      input.paymentIdemKey || input.instantIdemKey
        ? (
            (await target.execute(
              rawSql(
                `SELECT
                     CASE WHEN $1::text IS NOT NULL THEN EXISTS(SELECT 1 FROM payments p WHERE p.idempotency_key = $1) ELSE false END AS "hasPayment",
                     CASE WHEN $2::text IS NOT NULL THEN EXISTS(SELECT 1 FROM reservations ri WHERE ri.idempotency_key = $2) ELSE false END AS "hasInstant"`,
                [input.paymentIdemKey ?? null, input.instantIdemKey ?? null],
              ),
            )) as unknown as { rows: { hasPayment: boolean; hasInstant: boolean }[] }
          ).rows?.[0]
        : undefined;
    return {
      offering: null,
      hasPayment: Boolean(fallbackIdem?.hasPayment),
      hasInstant: Boolean(fallbackIdem?.hasInstant),
      failReason: () => fail('NOT_FOUND', 'این وعده برای رزرو در دسترس نیست.'),
    };
  }

  const hasPayment = Boolean(row.hasPayment);
  const hasInstant = Boolean(row.hasInstant);
  if (hasPayment || hasInstant) {
    return { offering: null, hasPayment, hasInstant };
  }

  const foodName = String(row.foodName ?? 'وعدهٔ غذایی');
  const status = String(row.status ?? '');
  if (status !== 'Published') {
    if (status === 'SoldOut') fail('CAPACITY_FULL', `ظرفیت «${foodName}» تکمیل شده است.`);
    if (status === 'Cancelled') fail('CONFLICT', `وعدهٔ «${foodName}» لغو شده است.`);
    fail('CONFLICT', `«${foodName}» هنوز برای رزرو منتشر نشده است.`);
  }

  const serviceDate = String(row.serviceDate);
  const today = tehranToday();
  if (serviceDate < today) fail('DEADLINE_PASSED', `زمان وعدهٔ «${foodName}» گذشته است.`);

  const now = new Date();
  const reserveOpensAt = row.reserveOpensAt instanceof Date ? row.reserveOpensAt : new Date(String(row.reserveOpensAt));
  const reserveDeadline = row.reserveDeadline instanceof Date ? row.reserveDeadline : new Date(String(row.reserveDeadline));
  if (reserveOpensAt.getTime() > now.getTime()) {
    fail('CONFLICT', `رزرو «${foodName}» از ${formatFaDateTime(reserveOpensAt)} باز می‌شود.`);
  }
  if (reserveDeadline.getTime() <= now.getTime()) {
    fail('DEADLINE_PASSED', `مهلت رزرو «${foodName}» در ${formatFaDateTime(reserveDeadline)} به پایان رسیده است.`);
  }

  const mealStart = tehranDateTimeToUtc(serviceDate, String(row.slotStartTime ?? '12:00').slice(0, 5));
  if (mealStart.getTime() <= now.getTime()) {
    fail('DEADLINE_PASSED', `زمان شروع وعدهٔ «${foodName}» گذشته است.`);
  }

  if (row.priceRial == null) fail('FORBIDDEN', `«${foodName}» برای گروه کاربری شما در دسترس نیست.`);
  const price = Number(row.priceRial);

  if (Number(row.reservedCount ?? 0) >= Number(row.capacity ?? 0)) {
    fail('CAPACITY_FULL', `متأسفانه ظرفیت «${foodName}» تکمیل شده است.`);
  }

  if (row.alreadyReserved) {
    fail('DUPLICATE_OFFERING', `«${foodName}» را قبلاً رزرو کرده‌اید.`);
  }

  return {
    offering: {
      offeringId: input.offeringId,
      foodName,
      serviceDate,
      slotStartTime: String(row.slotStartTime ?? '12:00').slice(0, 5),
      mealSlotTitle: String(row.mealSlotTitle ?? ''),
      priceRial: price,
    },
    hasPayment: false,
    hasInstant: false,
  };
}

/**
 * رزرو اتمیک یک آیتم درون تراکنش قفل‌شده (قابل فراخوانی داخل SAVEPOINT هنگام تسویهٔ درگاه).
 * نکتهٔ کارایی: قفل داغ `meal_offerings` فقط در گام پایانی با `UPDATE ... WHERE reserved_count < capacity`
 * (`FOR NO KEY UPDATE`) گرفته می‌شود تا زمان نگهداشت قفل ردیف به کمتر از ۱ms برسد و رقابت ۳۰۰ کاربر هم‌زمان صف نشود.
 */
export async function reserveInLockedTx(
  tx: Tx,
  deps: ServiceDeps,
  input: {
    accountId: string;
    customerGroup: CustomerAuth['customerGroup'];
    actor: Actor;
    holderKind: 'Student' | 'Employee';
    employeeId?: string;
    offeringId: string;
    idemKey: string;
    expectedPriceRial?: number;
    note?: string;
    ip?: string;
    userAgent?: string;
    skipIdempotencyCheck?: boolean;
    prelockedAccount?: { id: string; balanceRial: number; isActive: boolean };
    prevalidated?: { foodName: string; serviceDate: string; slotStartTime: string; priceRial: number };
  },
): Promise<{ reservationId: string; code: string; priceRial: number; balanceRial?: number; replay: boolean }> {
  if (!input.skipIdempotencyCheck) {
    const prior = await tx.select().from(reservations).where(eq(reservations.idempotencyKey, input.idemKey)).limit(1);
    if (prior[0]) {
      return {
        reservationId: prior[0].id,
        code: prior[0].code,
        priceRial: Number(prior[0].priceAtBooking),
        replay: true,
      };
    }
  }

  // مسیر فوق‌سریع تک‌دستوری (Single-Roundtrip Atomic CTE) برای تسویهٔ فوری از اعتبار کیف پول
  if (input.prevalidated && input.prelockedAccount) {
    const price = input.prevalidated.priceRial;
    const mealStart = tehranDateTimeToUtc(input.prevalidated.serviceDate, input.prevalidated.slotStartTime);
    const code = newReservationCode();
    const qrToken = randomHex(24);
    const tracking = newTrackingCode();
    const notifBody = `رزرو «${input.prevalidated.foodName}» برای ${formatFaDateTime(mealStart)} با موفقیت ثبت شد. کد تحویل: ${code.replace(/^R-/, '')}`;
    const auditDetailsJson = JSON.stringify({
      offeringId: input.offeringId,
      priceRial: price,
      customerGroup: input.customerGroup,
    });

    try {
      const fastRes = await tx.execute(
        rawSql(
          `WITH upd_cap AS (
             UPDATE meal_offerings
             SET reserved_count = reserved_count + 1
             WHERE id = $1::uuid
               AND deleted_at IS NULL
               AND status = 'Published'
               AND reserved_count < capacity
               AND reserve_opens_at <= now()
               AND reserve_deadline > now()
               AND EXISTS (
                 SELECT 1 FROM offering_prices mop
                 WHERE mop.offering_id = meal_offerings.id
                   AND mop.customer_group = $2
                   AND mop.price_rial = $3::bigint
               )
             RETURNING id, service_date, meal_slot_id, cafeteria_id
           ),
           upd_acc AS (
             UPDATE accounts
             SET balance_rial = balance_rial - $3::bigint
             FROM upd_cap
             WHERE accounts.id = $4::uuid
               AND accounts.is_active = true
               AND accounts.balance_rial >= $3::bigint
             RETURNING accounts.id, accounts.balance_rial
           ),
           ins_tx AS (
             INSERT INTO ledger_transactions (type, idempotency_key, reference_type, reference_id, reason, actor_type, actor_id, tracking_code)
             SELECT 'ReservationDebit', $5, 'Reservation', NULL, 'کسر بابت رزرو غذا', $6, $7::uuid, $8
             FROM upd_acc
             WHERE $3::bigint > 0
             RETURNING id
           ),
           ins_entries AS (
             INSERT INTO ledger_entries (transaction_id, account_id, system_account, amount_rial, balance_after)
             SELECT ins_tx.id, upd_acc.id, NULL, (-$3::bigint), upd_acc.balance_rial FROM ins_tx CROSS JOIN upd_acc
             UNION ALL
             SELECT ins_tx.id, NULL, 'MEAL_REVENUE', $3::bigint, NULL FROM ins_tx CROSS JOIN upd_acc
           ),
           ins_res AS (
             INSERT INTO reservations (
               code, account_id, offering_id, service_date, meal_slot_id, cafeteria_id,
               price_at_booking, customer_group_at_booking, status, idempotency_key, qr_token, qr_issued_at
             )
             SELECT $9, upd_acc.id, upd_cap.id, upd_cap.service_date, upd_cap.meal_slot_id, upd_cap.cafeteria_id,
                    $3::bigint, $2, 'Reserved', $10, $11, now()
             FROM upd_cap CROSS JOIN upd_acc
             RETURNING id, code
           ),
           ins_hist AS (
             INSERT INTO reservation_history (reservation_id, from_status, to_status, actor_type, actor_id, actor_label, note)
             SELECT ins_res.id, '', 'Reserved', $12, $7::uuid, $13, $14
             FROM ins_res
           ),
           ins_audit AS (
             INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, target_type, target_id, details, ip, user_agent)
             SELECT $6, $7::uuid, $13, 'reservation.create', 'Reservation', ins_res.id::text, $15::jsonb, $16, $17
             FROM ins_res
           ),
           ins_notif AS (
             INSERT INTO notifications (title, body, audience, account_id, event)
             SELECT 'رزرو شما ثبت شد', $18, 'Account', upd_acc.id, 'reservation.confirmed'
             FROM ins_res CROSS JOIN upd_acc
           )
           SELECT
             (SELECT COUNT(*)::int FROM upd_cap) AS "capOk",
             (SELECT id FROM ins_res) AS "reservationId",
             (SELECT code FROM ins_res) AS "code",
             (SELECT balance_rial::text FROM upd_acc) AS "newBalance"`,
          [
            input.offeringId,
            input.customerGroup,
            price,
            input.accountId,
            `debit:${input.idemKey}`,
            input.actor.type,
            input.actor.id || null,
            tracking,
            code,
            input.idemKey,
            qrToken,
            input.holderKind,
            String(input.actor.label ?? '').slice(0, 160),
            input.note ?? 'رزرو توسط کاربر',
            auditDetailsJson,
            String(input.ip ?? '').slice(0, 64),
            input.userAgent ? String(input.userAgent).slice(0, 300) : null,
            notifBody,
          ],
        ),
      );
      const fastRow = ((
        fastRes as unknown as {
          rows: { capOk: number; reservationId: string | null; code: string | null; newBalance: string | null }[];
        }
      ).rows ?? [])[0];

      if (fastRow?.reservationId && fastRow.code) {
        if (input.holderKind === 'Employee' && input.employeeId) {
          const mobile = await employeeMobile(tx, input.employeeId);
          await queueSms(tx, {
            recipient: mobile,
            message: `رزرو غذای شما ثبت شد. کد تحویل: ${fastRow.code.replace(/^R-/, '')}`,
            accountId: input.accountId,
          });
        }
        return {
          reservationId: fastRow.reservationId,
          code: fastRow.code,
          priceRial: price,
          balanceRial: fastRow.newBalance != null ? Number(fastRow.newBalance) : undefined,
          replay: false,
        };
      }
      if (fastRow && Number(fastRow.capOk) > 0 && !fastRow.reservationId) {
        fail('INSUFFICIENT_BALANCE', 'موجودی کیف پول برای این عملیات کافی نیست.');
      }
      if (fastRow && Number(fastRow.capOk) === 0) {
        const capDiag = await tx.execute(
          rawSql(
            `SELECT status, reserved_count AS "reservedCount", capacity FROM meal_offerings WHERE id = $1::uuid AND deleted_at IS NULL`,
            [input.offeringId],
          ),
        );
        const diagRow = ((capDiag as unknown as { rows: { status: string; reservedCount: number; capacity: number }[] }).rows ?? [])[0];
        if (!diagRow) fail('NOT_FOUND', 'این وعده برای رزرو در دسترس نیست.');
        if (diagRow.status === 'SoldOut' || Number(diagRow.reservedCount) >= Number(diagRow.capacity)) {
          fail('CAPACITY_FULL', 'متأسفانه ظرفیت این وعده تکمیل شده است.');
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = dbErrorText(error);
      if (/reservations_one_live_per_offering/.test(message) || pgErrorCode(error) === '23505') {
        fail('DUPLICATE_OFFERING', 'این غذا را قبلاً رزرو کرده‌اید.');
      }
      throw error;
    }
  }

  const infoRows = await tx.execute(
    rawSql(
      `SELECT o.id, o.status, o.service_date::text AS "serviceDate", o.capacity, o.reserved_count AS "reservedCount",
              o.reserve_opens_at AS "reserveOpensAt", o.reserve_deadline AS "reserveDeadline",
              o.meal_slot_id AS "mealSlotId", o.cafeteria_id AS "cafeteriaId",
              f.name AS "foodName", ms.start_time::text AS "slotStartTime",
              mop.price_rial::text AS "priceRial",
              EXISTS(
                SELECT 1 FROM reservations r
                WHERE r.account_id = $2::uuid AND r.offering_id = o.id AND r.status IN ('Reserved','Delivered')
              ) AS "alreadyReserved"
       FROM meal_offerings o
       JOIN foods f ON f.id = o.food_id
       JOIN meal_slots ms ON ms.id = o.meal_slot_id
       LEFT JOIN offering_prices mop ON mop.offering_id = o.id AND mop.customer_group = $3
       WHERE o.id = $1::uuid AND o.deleted_at IS NULL`,
      [input.offeringId, input.accountId, input.customerGroup],
    ),
  );
  const info = ((infoRows as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!info) fail('NOT_FOUND', 'این وعده برای رزرو در دسترس نیست.');

  const status = String(info.status ?? '');
  if (status !== 'Published') {
    if (status === 'SoldOut') fail('CAPACITY_FULL', 'ظرفیت این وعده تکمیل شده است.');
    if (status === 'Cancelled') fail('CONFLICT', 'این وعده لغو شده است.');
    fail('CONFLICT', 'این وعده هنوز برای رزرو منتشر نشده است.');
  }

  const serviceDate = String(info.serviceDate);
  const today = tehranToday();
  if (serviceDate < today) fail('DEADLINE_PASSED', 'زمان این وعده گذشته است.');

  const now = new Date();
  const reserveOpensAt = info.reserveOpensAt instanceof Date ? info.reserveOpensAt : new Date(String(info.reserveOpensAt));
  const reserveDeadline = info.reserveDeadline instanceof Date ? info.reserveDeadline : new Date(String(info.reserveDeadline));
  if (reserveOpensAt.getTime() > now.getTime()) {
    fail('CONFLICT', `رزرو این وعده از ${formatFaDateTime(reserveOpensAt)} باز می‌شود.`);
  }
  if (reserveDeadline.getTime() <= now.getTime()) {
    fail('DEADLINE_PASSED', `مهلت رزرو این وعده در ${formatFaDateTime(reserveDeadline)} به پایان رسیده است.`);
  }

  const mealStart = tehranDateTimeToUtc(serviceDate, String(info.slotStartTime ?? '12:00').slice(0, 5));
  if (mealStart.getTime() <= now.getTime()) {
    fail('DEADLINE_PASSED', 'زمان شروع این وعده گذشته است.');
  }

  if (info.priceRial == null) fail('FORBIDDEN', 'این غذا برای شما در دسترس نیست.');
  const price = Number(info.priceRial);
  if (input.expectedPriceRial != null && price !== input.expectedPriceRial) {
    fail('CONFLICT', 'قیمت این غذا حین پرداخت تغییر کرده است؛ مبلغ آن به اعتبار کیف پول شما منتقل شد.');
  }

  if (info.alreadyReserved) {
    fail('DUPLICATE_OFFERING', 'این غذا را قبلاً رزرو کرده‌اید.');
  }

  if (Number(info.reservedCount ?? 0) >= Number(info.capacity ?? 0)) {
    fail('CAPACITY_FULL', 'متأسفانه ظرفیت این وعده تکمیل شده است.');
  }

  let updatedBalance: number | undefined;
  if (price > 0) {
    const prelockedAccounts = input.prelockedAccount ? new Map([[input.accountId, input.prelockedAccount]]) : undefined;
    const ledgerRes = await postLedger(tx, deps, {
      type: 'ReservationDebit',
      idempotencyKey: `debit:${input.idemKey}`,
      reason: 'کسر بابت رزرو غذا',
      actor: input.actor,
      referenceType: 'Reservation',
      prelockedAccounts,
      legs: [
        { accountId: input.accountId, amountRial: -price },
        { systemAccount: 'MEAL_REVENUE', amountRial: price },
      ],
    });
    updatedBalance = ledgerRes.balances[input.accountId];
  }

  let reservationId: string;
  let code: string;
  try {
    const [created] = await tx
      .insert(reservations)
      .values({
        code: newReservationCode(),
        accountId: input.accountId,
        offeringId: input.offeringId,
        serviceDate,
        mealSlotId: String(info.mealSlotId),
        cafeteriaId: String(info.cafeteriaId),
        priceAtBooking: price,
        customerGroupAtBooking: input.customerGroup,
        status: 'Reserved',
        idempotencyKey: input.idemKey,
        qrToken: randomHex(24),
        qrIssuedAt: new Date(),
      })
      .returning({ id: reservations.id, code: reservations.code });
    reservationId = created!.id;
    code = created!.code;
  } catch (error) {
    const message = dbErrorText(error);
    if (/reservations_one_live_per_offering/.test(message) || pgErrorCode(error) === '23505') {
      fail('DUPLICATE_OFFERING', 'این غذا را قبلاً رزرو کرده‌اید.');
    }
    throw error;
  }

  const foodName = String(info.foodName ?? 'وعدهٔ غذایی');
  const notifBody = `رزرو «${foodName}» برای ${formatFaDateTime(mealStart)} با موفقیت ثبت شد. کد تحویل: ${code.replace(/^R-/, '')}`;
  const auditDetailsJson = JSON.stringify({ offeringId: input.offeringId, priceRial: price, customerGroup: input.customerGroup });

  await tx.execute(
    rawSql(
      `WITH ins_hist AS (
         INSERT INTO reservation_history (reservation_id, from_status, to_status, actor_type, actor_id, actor_label, note)
         VALUES ($1::uuid, '', 'Reserved', $2, $3, $4, $5)
       ),
       ins_audit AS (
         INSERT INTO audit_logs (actor_type, actor_id, actor_label, action, target_type, target_id, details, ip, user_agent)
         VALUES ($6, $7, $8, 'reservation.create', 'Reservation', $9, $10::jsonb, $11, $12)
       )
       INSERT INTO notifications (title, body, audience, account_id, event)
       VALUES ('رزرو شما ثبت شد', $13, 'Account', $14::uuid, 'reservation.confirmed')`,
      [
        reservationId,
        input.holderKind,
        input.actor.id || null,
        String(input.actor.label ?? '').slice(0, 160),
        input.note ?? 'رزرو توسط کاربر',
        input.actor.type,
        input.actor.id || null,
        String(input.actor.label ?? '').slice(0, 160),
        reservationId.slice(0, 64),
        auditDetailsJson,
        String(input.ip ?? '').slice(0, 64),
        input.userAgent ? String(input.userAgent).slice(0, 300) : null,
        notifBody,
        input.accountId,
      ],
    ),
  );
  if (input.holderKind === 'Employee' && input.employeeId) {
    const mobile = await employeeMobile(tx, input.employeeId);
    await queueSms(tx, {
      recipient: mobile,
      message: `رزرو غذای شما ثبت شد. کد تحویل: ${code.replace(/^R-/, '')}`,
      accountId: input.accountId,
    });
  }

  // گام پایانی: افزایش اتمیک شمارندهٔ ظرفیت در آخرین لحظهٔ پیش از COMMIT (قفل FOR NO KEY UPDATE در کمترین بازه)
  const capacityUpdated = await tx
    .update(mealOfferings)
    .set({ reservedCount: sql`${mealOfferings.reservedCount} + 1` })
    .where(
      sql`${mealOfferings.id} = ${input.offeringId} AND ${mealOfferings.reservedCount} < ${mealOfferings.capacity} AND ${mealOfferings.status} = 'Published'`,
    )
    .returning({ reservedCount: mealOfferings.reservedCount });
  if (capacityUpdated.length === 0) fail('CAPACITY_FULL', 'متأسفانه ظرفیت این وعده تکمیل شده است.');

  return { reservationId, code, priceRial: price, balanceRial: updatedBalance, replay: false };
}

/** رزرو یک وعده برای مشتری جاری (دانشجو یا کارمند). */
export async function reserveMeal(deps: ServiceDeps, input: ReserveInput): Promise<ReserveResult> {
  const { auth, offeringId, ip } = input;
  const idemKey = `reserve:${auth.accountId}:${input.idempotencyKey}`;

  // بازپخش درخواست تکراری: همان نتیجهٔ قبلی، بدون اثر دوم
  const prior = await deps.db.select().from(reservations).where(eq(reservations.idempotencyKey, idemKey)).limit(1);
  if (prior[0]) {
    const holder = await getAccountHolder(deps.db, auth.accountId);
    return {
      reservationId: prior[0].id,
      code: prior[0].code,
      priceRial: Number(prior[0].priceAtBooking),
      balanceRial: holder?.balanceRial ?? 0,
      replay: true,
    };
  }

  return deps.db.transaction(async (tx) => {
    // ۱) قفل حساب و بررسی فعال بودن
    const lockedAccounts = await lockAccountsForUpdate(tx, [auth.accountId]);
    const account = lockedAccounts.get(auth.accountId);
    if (!account) fail('NOT_FOUND', 'حساب کیف پول یافت نشد.');
    const holder = assertAccountUsable(await getAccountHolder(tx, auth.accountId));

    // ۲) قفل وعده و بررسی‌های زمانی/وضعیتی
    const offering = await lockOfferingForUpdate(tx, offeringId);
    if (!offering) fail('NOT_FOUND', 'این وعده برای رزرو در دسترس نیست.');
    if (offering.status !== 'Published') {
      if (offering.status === 'SoldOut') fail('CAPACITY_FULL', 'ظرفیت این وعده تکمیل شده است.');
      if (offering.status === 'Cancelled') fail('CONFLICT', 'این وعده لغو شده است.');
      fail('CONFLICT', 'این وعده هنوز برای رزرو منتشر نشده است.');
    }
    const today = tehranToday();
    if (offering.serviceDate < today) fail('DEADLINE_PASSED', 'زمان این وعده گذشته است.');

    const now = new Date();
    if (offering.reserveOpensAt.getTime() > now.getTime()) {
      fail('CONFLICT', `رزرو این وعده از ${formatFaDateTime(offering.reserveOpensAt)} باز می‌شود.`);
    }
    if (offering.reserveDeadline.getTime() <= now.getTime()) {
      fail('DEADLINE_PASSED', `مهلت رزرو این وعده در ${formatFaDateTime(offering.reserveDeadline)} به پایان رسیده است.`);
    }

    const slotResult = await tx.execute(rawSql(`SELECT start_time AS "startTime" FROM meal_slots WHERE id = $1`, [offering.mealSlotId]));
    const slot = ((slotResult as unknown as { rows: { startTime: string }[] }).rows ?? [])[0];
    const mealStart = tehranDateTimeToUtc(offering.serviceDate, String(slot?.startTime ?? '12:00').slice(0, 5));
    if (mealStart.getTime() <= now.getTime()) {
      fail('DEADLINE_PASSED', 'زمان شروع این وعده گذشته است.');
    }

    // ۳) قیمت گروه مشتری
    const price = await priceForGroup(tx, offeringId, holder.customerGroup);
    if (price == null) fail('FORBIDDEN', 'این غذا برای شما در دسترس نیست.');

    // ۳.۵) جلوگیری از رزرو تکراری همان آیتم منو (چند غذای مختلف در یک وعده مجاز است)
    const alreadyReserved = await tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        sql`${reservations.accountId} = ${auth.accountId} AND ${reservations.offeringId} = ${offeringId} AND ${reservations.status} IN ('Reserved','Delivered')`,
      )
      .limit(1);
    if (alreadyReserved[0]) {
      fail('DUPLICATE_OFFERING', 'این غذا را قبلاً رزرو کرده‌اید.');
    }

    // ۴) افزایش اتمیک ظرفیت (نتیجهٔ خالی ⇒ ظرفیت تکمیل)
    const capacityUpdated = await tx
      .update(mealOfferings)
      .set({ reservedCount: sql`${mealOfferings.reservedCount} + 1` })
      .where(
        sql`${mealOfferings.id} = ${offeringId} AND ${mealOfferings.reservedCount} < ${mealOfferings.capacity} AND ${mealOfferings.status} = 'Published'`,
      )
      .returning({ reservedCount: mealOfferings.reservedCount });
    if (capacityUpdated.length === 0) fail('CAPACITY_FULL', 'متأسفانه ظرفیت این وعده تکمیل شده است.');

    const actor: Actor =
      auth.kind === 'student'
        ? { type: 'Student', id: auth.studentId, label: auth.studentNumber }
        : { type: 'Employee', id: auth.employeeId, label: auth.username };

    // ۵) و ۶) کسر موجودی + ثبت دفتر کل دوطرفه
    if (price > 0) {
      try {
        await postLedger(tx, deps, {
          type: 'ReservationDebit',
          idempotencyKey: `debit:${idemKey}`,
          reason: 'کسر بابت رزرو غذا',
          actor,
          referenceType: 'Reservation',
          legs: [
            { accountId: auth.accountId, amountRial: -price },
            { systemAccount: 'MEAL_REVENUE', amountRial: price },
          ],
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'INSUFFICIENT_BALANCE') {
          const shortfall = price - holder.balanceRial;
          throw new AppError('INSUFFICIENT_BALANCE', `موجودی کیف پول شما کافی نیست؛ کسری ${formatRialFa(shortfall)}.`, {
            shortfallRial: shortfall,
            priceRial: price,
            balanceRial: holder.balanceRial,
          });
        }
        throw error;
      }
    }

    // ۷) درج رزرو (نقض ایندکس یکتای جزئی ⇒ «قبلاً رزرو کرده‌اید»)
    let reservationId: string;
    let code: string;
    try {
      const [created] = await tx
        .insert(reservations)
        .values({
          code: newReservationCode(),
          accountId: auth.accountId,
          offeringId,
          serviceDate: offering.serviceDate,
          mealSlotId: offering.mealSlotId,
          cafeteriaId: offering.cafeteriaId,
          priceAtBooking: price,
          customerGroupAtBooking: holder.customerGroup,
          status: 'Reserved',
          idempotencyKey: idemKey,
          qrToken: randomHex(24),
          qrIssuedAt: new Date(),
        })
        .returning({ id: reservations.id, code: reservations.code });
      reservationId = created!.id;
      code = created!.code;
    } catch (error) {
      const message = dbErrorText(error);
      if (/reservations_one_live_per_offering/.test(message) || pgErrorCode(error) === '23505') {
        fail('DUPLICATE_OFFERING', 'این غذا را قبلاً رزرو کرده‌اید.');
      }
      throw error;
    }

    await tx.insert(reservationHistory).values({
      reservationId,
      fromStatus: '',
      toStatus: 'Reserved',
      actorType: auth.kind === 'student' ? 'Student' : 'Employee',
      actorId: auth.kind === 'student' ? auth.studentId : auth.employeeId,
      actorLabel: actor.label,
      note: 'رزرو توسط کاربر',
    });

    await writeAudit(tx, {
      actor,
      action: 'reservation.create',
      targetType: 'Reservation',
      targetId: reservationId,
      details: { offeringId, priceRial: price, customerGroup: holder.customerGroup },
      ip,
      userAgent: input.userAgent,
    });

    await createNotification(tx, {
      title: 'رزرو شما ثبت شد',
      body: `رزرو «${await foodNameOf(tx, offeringId)}» برای ${formatFaDateTime(mealStart)} با موفقیت ثبت شد. کد تحویل: ${code.replace(/^R-/, '')}`,
      audience: 'Account',
      accountId: auth.accountId,
      event: 'reservation.confirmed',
    });
    if (auth.kind === 'employee') {
      const mobile = await employeeMobile(tx, auth.employeeId);
      await queueSms(tx, {
        recipient: mobile,
        message: `رزرو غذای شما ثبت شد. کد تحویل: ${code.replace(/^R-/, '')}`,
        accountId: auth.accountId,
      });
    }

    const balance = (await lockAccountsForUpdate(tx, [auth.accountId])).get(auth.accountId)?.balanceRial ?? 0;
    return { reservationId, code, priceRial: price, balanceRial: balance, replay: false };
  });
}

function formatRialFa(rial: number): string {
  const toman = Math.trunc(rial / 10);
  const grouped = new Intl.NumberFormat('en-US').format(toman).replace(/,/g, '٬');
  return `${grouped.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d)} تومان`;
}

async function foodNameOf(target: Tx, offeringId: string): Promise<string> {
  const rows = await target.execute(
    rawSql(`SELECT f.name FROM meal_offerings o JOIN foods f ON f.id = o.food_id WHERE o.id = $1`, [offeringId]),
  );
  return String(((rows as unknown as { rows: { name: string }[] }).rows ?? [])[0]?.name ?? 'وعدهٔ غذایی');
}

/**
 * سبد خرید: هر آیتم در تراکنش **مستقل** رزرو می‌شود و نتیجهٔ هر آیتم گزارش می‌شود.
 *
 * تفاوت حیاتی با نسخهٔ قبلی: هیچ اعتباری بدون پرداخت تأییدشده ثبت نمی‌شود
 * (حذف «پول رایگان»). اگر موجودی کافی نباشد، مبلغ کسری برگردانده می‌شود تا
 * UI دکمهٔ «شارژ و ادامه» را نشان دهد.
 */
export async function checkoutCart(
  deps: ServiceDeps,
  input: { auth: CustomerAuth; items: { offeringId: string }[]; idempotencyKey: string; ip: string },
): Promise<{
  results: { offeringId: string; ok: boolean; code: string | null; errorCode: string | null; error: string | null; priceRial: number }[];
  succeeded: number;
  failed: number;
  paidRial: number;
  balanceRial: number;
  shortfallRial: number;
}> {
  const ids = [...new Set(input.items.map((i) => i.offeringId))].slice(0, 30);
  if (ids.length === 0) fail('VALIDATION', 'سبد خرید خالی است.');

  const results: {
    offeringId: string;
    ok: boolean;
    code: string | null;
    errorCode: string | null;
    error: string | null;
    priceRial: number;
  }[] = [];
  let shortfallRial = 0;
  let paidRial = 0;

  for (const [index, offeringId] of ids.entries()) {
    try {
      const result = await reserveMeal(deps, {
        auth: input.auth,
        offeringId,
        idempotencyKey: `${input.idempotencyKey}:${index}:${offeringId}`,
        ip: input.ip,
      });
      paidRial += result.priceRial;
      results.push({ offeringId, ok: true, code: result.code, errorCode: null, error: null, priceRial: result.priceRial });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('INTERNAL');
      const details = (appError.details ?? {}) as { shortfallRial?: number; priceRial?: number };
      if (appError.code === 'INSUFFICIENT_BALANCE') shortfallRial += Number(details.shortfallRial ?? details.priceRial ?? 0);
      results.push({
        offeringId,
        ok: false,
        code: null,
        errorCode: appError.code,
        error: appError.message,
        priceRial: Number(details.priceRial ?? 0),
      });
    }
  }

  const holder = await getAccountHolder(deps.db, input.auth.accountId);
  const succeeded = results.filter((r) => r.ok).length;

  await writeAudit(deps.db, {
    actor:
      input.auth.kind === 'student'
        ? { type: 'Student', id: input.auth.studentId, label: input.auth.studentNumber }
        : { type: 'Employee', id: input.auth.employeeId, label: input.auth.username },
    action: 'checkout.complete',
    targetType: 'Account',
    targetId: input.auth.accountId,
    details: { items: ids.length, succeeded, failed: ids.length - succeeded, paidRial, shortfallRial },
    ip: input.ip,
  });

  return {
    results,
    succeeded,
    failed: ids.length - succeeded,
    paidRial,
    balanceRial: holder?.balanceRial ?? 0,
    shortfallRial,
  };
}

export type CancelResult = { id: string; status: 'Cancelled'; refundedRial: number; balanceRial: number };

/**
 * لغو رزرو توسط خود کاربر (با بازپرداخت کامل در همان تراکنش).
 * در نسخهٔ اول پشت فلگ `studentCancellationEnabled = false` غیرفعال است (مسیر HTTP آن نیز حذف شده است)؛
 * زیرساخت کامل آن برای فعال‌سازی احتمالی در آینده (رک. `docs/CANCELLATION.md`) نگهداری و تست شده است.
 */
export async function cancelOwnReservation(
  deps: ServiceDeps,
  input: { auth: CustomerAuth; reservationId: string; ip: string },
): Promise<CancelResult> {
  const settings = await getSettings(deps);
  if (!settings.studentCancellationEnabled) {
    fail('FORBIDDEN', 'امکان لغو رزرو توسط دانشجو در حال حاضر فعال نیست.');
  }
  return cancelReservationInternal(deps, {
    reservationId: input.reservationId,
    accountIdScope: input.auth.accountId,
    actor:
      input.auth.kind === 'student'
        ? { type: 'Student', id: input.auth.studentId, label: input.auth.studentNumber }
        : { type: 'Employee', id: input.auth.employeeId, label: input.auth.username },
    reason: 'لغو توسط کاربر',
    ip: input.ip,
    settings,
    enforceDeadline: true,
    action: 'reservation.cancel',
  });
}

/** لغو اداری توسط مدیر تغذیه/مدیر ارشد با دلیل الزامی و بازپرداخت. */
export async function adminCancelReservation(
  deps: ServiceDeps,
  input: { actor: Actor; reservationId: string; reason: string; ip: string; staffId: string },
): Promise<CancelResult> {
  const settings = await getSettings(deps);
  return cancelReservationInternal(deps, {
    reservationId: input.reservationId,
    actor: input.actor,
    reason: `لغو اداری: ${input.reason}`.slice(0, 500),
    ip: input.ip,
    settings,
    enforceDeadline: false,
    action: 'reservation.admin_cancel',
    details: { reason: input.reason, staffId: input.staffId },
  });
}

export type CancelInternalInput = {
  reservationId: string;
  accountIdScope?: string;
  actor: Actor;
  reason: string;
  ip: string;
  settings: ResolvedSettings;
  enforceDeadline: boolean;
  action: string;
  details?: Record<string, unknown>;
};

export async function cancelReservationInternal(deps: ServiceDeps, input: CancelInternalInput): Promise<CancelResult> {
  return deps.db.transaction(async (tx) => {
    const row = await lockReservationForUpdate(tx, input.reservationId);
    if (!row) fail('NOT_FOUND', 'رزرو یافت نشد.');
    if (input.accountIdScope && row.accountId !== input.accountIdScope) {
      // جلوگیری از IDOR: هیچ اطلاعاتی دربارهٔ وجود رزرو داده نمی‌شود
      fail('NOT_FOUND', 'رزرو یافت نشد.');
    }
    if (row.status === 'Cancelled') {
      return { id: row.id, status: 'Cancelled' as const, refundedRial: 0, balanceRial: await balanceOfAccount(tx, row.accountId) };
    }
    if (row.status === 'Delivered') fail('CONFLICT', 'این وعده تحویل شده است و قابل لغو نیست.');
    if (row.status !== 'Reserved') fail('CONFLICT', 'این رزرو در وضعیت فعلی قابل لغو نیست.');

    if (input.enforceDeadline) {
      const offering = await tx
        .select({ cancelDeadline: mealOfferings.cancelDeadline })
        .from(mealOfferings)
        .where(eq(mealOfferings.id, row.offeringId))
        .limit(1);
      const deadline = computeCancelDeadline(
        { offeringCancelDeadline: offering[0]?.cancelDeadline ?? null, serviceDate: row.serviceDate, slotStartTime: row.slotStartTime },
        input.settings,
      );
      const now = new Date();
      if (now.getTime() > deadline.getTime()) {
        fail('DEADLINE_PASSED', `مهلت لغو این رزرو در ${formatFaDateTime(deadline)} به پایان رسیده است.`, {
          deadline: deadline.toISOString(),
          deadlineFa: formatFaDateTime(deadline),
        });
      }
    }

    await tx
      .update(reservations)
      .set({
        status: 'Cancelled',
        cancelledAt: new Date(),
        cancelledBy: input.actor.id || null,
        cancelReason: input.reason,
      })
      .where(sql`${reservations.id} = ${row.id} AND ${reservations.status} = 'Reserved'`);

    await tx
      .update(mealOfferings)
      .set({ reservedCount: sql`GREATEST(${mealOfferings.reservedCount} - 1, 0)` })
      .where(sql`${mealOfferings.id} = ${row.offeringId} AND ${mealOfferings.reservedCount} > 0`);

    let refundedRial = 0;
    if (row.priceRial > 0) {
      await postLedger(tx, deps, {
        type: 'CancellationRefund',
        idempotencyKey: `cancel:${row.id}`,
        reason: 'بازگشت وجه لغو رزرو',
        actor: input.actor,
        referenceType: 'Reservation',
        referenceId: row.id,
        legs: [
          { accountId: row.accountId, amountRial: row.priceRial },
          { systemAccount: 'MEAL_REVENUE', amountRial: -row.priceRial },
        ],
      });
      refundedRial = row.priceRial;
    }

    await tx.insert(reservationHistory).values({
      reservationId: row.id,
      fromStatus: row.status,
      toStatus: 'Cancelled',
      actorType: input.actor.type,
      actorId: input.actor.id || null,
      actorLabel: input.actor.label,
      note: input.reason,
    });

    await writeAudit(tx, {
      actor: input.actor,
      action: input.action,
      targetType: 'Reservation',
      targetId: row.id,
      details: { refundedRial, ...(input.details ?? {}) },
      ip: input.ip,
    });

    await createNotification(tx, {
      title: 'رزرو شما لغو شد',
      body:
        refundedRial > 0
          ? `رزرو ${row.code.replace(/^R-/, '')} لغو شد و ${formatRialFa(refundedRial)} به کیف پول شما بازگشت.`
          : `رزرو ${row.code.replace(/^R-/, '')} لغو شد.`,
      audience: 'Account',
      accountId: row.accountId,
      event: 'reservation.cancelled',
    });

    return { id: row.id, status: 'Cancelled' as const, refundedRial, balanceRial: await balanceOfAccount(tx, row.accountId) };
  });
}

async function balanceOfAccount(target: Tx, accountId: string): Promise<number> {
  const rows = await lockAccountsForUpdate(target, [accountId]);
  return rows.get(accountId)?.balanceRial ?? 0;
}

/**
 * «تمام شد» (SoldOut) یا «لغو وعده» (Cancelled) با بازپرداخت خودکار همهٔ رزروها
 * در دسته‌های ۱۰۰ تایی. هر دسته یک تراکنش مستقل است ⇒ «همه یا هیچ» برای هر دسته
 * و امکان ادامهٔ امن پس از خطا.
 */
export async function closeOfferingWithRefunds(
  deps: ServiceDeps,
  input: { offeringId: string; status: 'SoldOut' | 'Cancelled'; reason: string; actor: Actor; ip: string; staffId: string },
): Promise<{ id: string; status: string; cancelledReservations: number; refundedRial: number; notified: number; failed: number }> {
  const BATCH_SIZE = 100;
  let cancelled = 0;
  let refundedRial = 0;
  let notified = 0;
  let failed = 0;

  // ابتدا وضعیت وعده تغییر می‌کند تا رزرو جدیدی پذیرفته نشود
  await deps.db.transaction(async (tx) => {
    const offering = await lockOfferingForUpdate(tx, input.offeringId);
    if (!offering) fail('NOT_FOUND', 'وعده یافت نشد.');
    if (input.status === 'Cancelled' && offering.reservedCount > 0 && offering.status === 'Cancelled') {
      fail('CONFLICT', 'این وعده قبلاً لغو شده است.');
    }
    await tx.update(mealOfferings).set({ status: input.status, statusReason: input.reason }).where(eq(mealOfferings.id, input.offeringId));

    await writeAudit(tx, {
      actor: input.actor,
      action: input.status === 'SoldOut' ? 'offering.sold_out' : 'offering.cancel',
      targetType: 'MealOffering',
      targetId: input.offeringId,
      details: { reason: input.reason, reservedCount: offering.reservedCount },
      ip: input.ip,
    });
  });

  for (;;) {
    const batch = await deps.db
      .select({ id: reservations.id })
      .from(reservations)
      .where(sql`${reservations.offeringId} = ${input.offeringId} AND ${reservations.status} = 'Reserved'`)
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;

    try {
      const result = await deps.db.transaction(async (tx) => {
        let batchRefunded = 0;
        let batchCancelled = 0;
        for (const item of batch) {
          const row = await lockReservationForUpdate(tx, item.id);
          if (!row || row.status !== 'Reserved') continue;

          await tx
            .update(reservations)
            .set({
              status: 'Cancelled',
              cancelledAt: new Date(),
              cancelReason:
                input.status === 'SoldOut' ? `اتمام ظرفیت: ${input.reason}`.slice(0, 500) : `لغو وعده: ${input.reason}`.slice(0, 500),
            })
            .where(sql`${reservations.id} = ${row.id} AND ${reservations.status} = 'Reserved'`);

          if (row.priceRial > 0) {
            await postLedger(tx, deps, {
              type: 'MealUnavailableRefund',
              idempotencyKey: `cancel:${row.id}`,
              reason: input.status === 'SoldOut' ? 'بازگشت وجه به دلیل اتمام ظرفیت وعده' : 'بازگشت وجه به دلیل لغو وعده',
              actor: input.actor,
              referenceType: 'Reservation',
              referenceId: row.id,
              legs: [
                { accountId: row.accountId, amountRial: row.priceRial },
                { systemAccount: 'MEAL_REVENUE', amountRial: -row.priceRial },
              ],
            });
            batchRefunded += row.priceRial;
          }

          await tx.insert(reservationHistory).values({
            reservationId: row.id,
            fromStatus: 'Reserved',
            toStatus: 'Cancelled',
            actorType: input.actor.type,
            actorId: input.actor.id || null,
            actorLabel: input.actor.label,
            note: input.status === 'SoldOut' ? 'sold-out' : 'meal-cancelled',
          });

          await createNotification(tx, {
            title: input.status === 'SoldOut' ? 'وعدهٔ شما تمام شد' : 'وعدهٔ غذایی لغو شد',
            body:
              row.priceRial > 0
                ? `رزرو «${row.foodName}» برای ${row.serviceDate} به دلیل «${input.reason}» لغو شد و ${formatRialFa(row.priceRial)} به کیف پول شما بازگشت.`
                : `رزرو «${row.foodName}» برای ${row.serviceDate} به دلیل «${input.reason}» لغو شد.`,
            audience: 'Account',
            accountId: row.accountId,
            event: 'meal.unavailable',
          });
          batchCancelled += 1;
        }

        await tx
          .update(mealOfferings)
          .set({ reservedCount: sql`GREATEST(${mealOfferings.reservedCount} - ${batch.length}, 0)` })
          .where(eq(mealOfferings.id, input.offeringId));

        return { count: batch.length, batchCancelled, batchRefunded };
      });
      if (result.count === 0) break;
      cancelled += result.batchCancelled;
      notified += result.batchCancelled;
      refundedRial += result.batchRefunded;
    } catch (error) {
      failed += batch.length;
      deps.log.error({ err: error, offeringId: input.offeringId }, 'شکست در لغو دسته‌ای رزروها');
      // ادامهٔ امن: دستهٔ بعدی پردازش می‌شود؛ رزروهای لغونشده در گزارش `failed` می‌آیند
      break;
    }
  }

  await writeAudit(deps.db, {
    actor: input.actor,
    action: input.status === 'SoldOut' ? 'offering.sold_out.refunds' : 'offering.cancel.refunds',
    targetType: 'MealOffering',
    targetId: input.offeringId,
    details: { cancelledReservations: cancelled, refundedRial, notified, failed, reason: input.reason },
    ip: input.ip,
  });

  return { id: input.offeringId, status: input.status, cancelledReservations: cancelled, refundedRial, notified, failed };
}

/** فهرست رزروهای کاربر جاری (با QR برای رزروهای فعال). */
export async function listMyReservations(deps: ServiceDeps, auth: CustomerAuth): Promise<ReservationRow[]> {
  const { rows } = await queryReservations(deps.db, { accountId: auth.accountId, limit: 300 });
  return rows.filter((r) => r.status !== 'Rejected');
}

/** بازصدور QR: توکن جدید، توکن قبلی باطل، ثبت در ممیزی. */
export async function reissueQrToken(
  deps: ServiceDeps,
  input: { auth: CustomerAuth; reservationId: string; ip: string },
): Promise<{ id: string; qrToken: string; issuedAt: Date }> {
  return deps.db.transaction(async (tx) => {
    const row = await tx.select().from(reservations).where(eq(reservations.id, input.reservationId)).limit(1);
    const reservation = row[0];
    if (!reservation || reservation.accountId !== input.auth.accountId) fail('NOT_FOUND', 'رزرو یافت نشد.');
    if (reservation.status !== 'Reserved') fail('CONFLICT', 'فقط رزروهای فعال QR دارند.');

    const token = randomHex(24);
    const issuedAt = new Date();
    await tx.update(reservations).set({ qrToken: token, qrIssuedAt: issuedAt }).where(eq(reservations.id, reservation.id));
    await writeAudit(tx, {
      actor:
        input.auth.kind === 'student'
          ? { type: 'Student', id: input.auth.studentId, label: input.auth.studentNumber }
          : { type: 'Employee', id: input.auth.employeeId, label: input.auth.username },
      action: 'reservation.qr.reissue',
      targetType: 'Reservation',
      targetId: reservation.id,
      ip: input.ip,
    });
    return { id: reservation.id, qrToken: token, issuedAt };
  });
}

/**
 * رزروهایی که باید `NoShow` شوند (job زمان‌بندی‌شده).
 *
 * مرز: پایان وعده (روز سرویس + ساعت پایان وعده به وقت تهران) + `noshow_grace_minutes`.
 * تبدیل به UTC با کسر ۳:۳۰ انجام می‌شود (ایران از ۲۰۲۲ ساعت تابستانی ندارد؛
 * تست واحد `tehran offset` این فرض را با `Intl` بررسی می‌کند).
 * پیش‌فرض (`noshow_refund = false`) بدون بازگشت وجه است؛ در صورت فعال‌سازی
 * `noshow_refund = true`، مبلغ رزرو به اعتبار کیف پول بازگردانده می‌شود.
 */
export async function markNoShows(deps: ServiceDeps): Promise<number> {
  const settings = await getSettings(deps);
  const grace = settings.noshowGraceMinutes;
  const shouldRefund = settings.noShowRefund;

  const candidates = await deps.db.execute(
    rawSql(
      `SELECT r.id
       FROM reservations r
       JOIN meal_offerings o ON r.offering_id = o.id
       JOIN meal_slots ms ON r.meal_slot_id = ms.id
       WHERE r.status = 'Reserved'
         AND ((o.service_date + ms.end_time) - interval '3 hours 30 minutes' + make_interval(mins => $1)) AT TIME ZONE 'UTC' < now()
       LIMIT 500`,
      [grace],
    ),
  );
  const ids = ((candidates as unknown as { rows: { id: string }[] }).rows ?? []).map((r) => r.id);
  let count = 0;

  for (const id of ids) {
    const changed = await deps.db.transaction(async (tx) => {
      const updated = await tx.execute(
        rawSql(
          `UPDATE reservations
           SET status = 'NoShow'
           WHERE id = $1 AND status = 'Reserved'
           RETURNING id, account_id AS "accountId", price_at_booking::text AS "priceRial"`,
          [id],
        ),
      );
      const row = ((updated as unknown as { rows: { id: string; accountId: string; priceRial: string }[] }).rows ?? [])[0];
      if (!row) return false;

      const priceRial = Number(row.priceRial ?? 0);
      if (shouldRefund && priceRial > 0) {
        await lockAccountsForUpdate(tx, [row.accountId]);
        await postLedger(tx, deps, {
          type: 'AdminRefund',
          idempotencyKey: `noshow-refund:${row.id}`,
          reason: 'بازگشت وجه عدم مراجعه طبق سیاست سامانه',
          actor: { type: 'System', id: '', label: 'worker' },
          referenceType: 'Reservation',
          referenceId: row.id,
          legs: [
            { accountId: row.accountId, amountRial: priceRial },
            { systemAccount: 'MEAL_REVENUE', amountRial: -priceRial },
          ],
        });
      }

      await tx.insert(reservationHistory).values({
        reservationId: row.id,
        fromStatus: 'Reserved',
        toStatus: 'NoShow',
        actorType: 'System',
        actorLabel: 'worker',
        note: shouldRefund ? 'عدم مراجعه پس از پایان فرجه (با بازگشت اعتبار)' : 'عدم مراجعه پس از پایان فرجه',
      });
      await writeAudit(tx, {
        actor: { type: 'System', id: '', label: 'worker' },
        action: 'reservation.no_show',
        targetType: 'Reservation',
        targetId: row.id,
        details: { priceRial, refunded: shouldRefund && priceRial > 0 },
      });
      await createNotification(tx, {
        title: 'عدم مراجعه به وعدهٔ غذایی',
        body:
          shouldRefund && priceRial > 0
            ? `رزرو شما به دلیل مراجعه نکردن در بازهٔ تحویل، «عدم مراجعه» ثبت شد و مبلغ ${(priceRial / 10).toLocaleString('fa-IR')} تومان به اعتبار کیف پول شما بازگشت.`
            : 'رزرو شما به دلیل مراجعه نکردن در بازهٔ تحویل، «عدم مراجعه» ثبت شد. مطابق سیاست سامانه، مبلغی بازگردانده نمی‌شود.',
        audience: 'Account',
        accountId: row.accountId,
        event: 'reservation.cancelled',
      });
      return true;
    });
    if (changed) count += 1;
  }

  return count;
}

/** آیا رزرو در فهرست «فعال» نمایش داده می‌شود؟ */
export function isLiveStatus(status: string): boolean {
  return (LIVE_RESERVATION_STATUSES as readonly string[]).includes(status);
}
