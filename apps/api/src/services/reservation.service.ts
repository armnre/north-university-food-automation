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
import { newReservationCode, randomHex } from '../lib/crypto.js';
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

/** لغو رزرو توسط خود کاربر (با بازپرداخت کامل در همان تراکنش). */
export async function cancelOwnReservation(
  deps: ServiceDeps,
  input: { auth: CustomerAuth; reservationId: string; ip: string },
): Promise<CancelResult> {
  const settings = await getSettings(deps);
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

type CancelInternalInput = {
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

async function cancelReservationInternal(deps: ServiceDeps, input: CancelInternalInput): Promise<CancelResult> {
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
      .set({ status: 'Cancelled', cancelledAt: new Date(), cancelReason: input.reason })
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
 * بدون بازگشت وجه — سیاست در متن‌های راهنما نمایش داده می‌شود.
 */
export async function markNoShows(deps: ServiceDeps): Promise<number> {
  const settings = await getSettings(deps);
  const grace = settings.noshowGraceMinutes;

  const updated = await deps.db.execute(
    rawSql(
      `UPDATE reservations r SET status = 'NoShow'
       FROM meal_offerings o, meal_slots ms
       WHERE r.offering_id = o.id
         AND r.meal_slot_id = ms.id
         AND r.status = 'Reserved'
         AND ((o.service_date + ms.end_time) - interval '3 hours 30 minutes' + make_interval(mins => $1)) AT TIME ZONE 'UTC' < now()
       RETURNING r.id, r.account_id AS "accountId", r.price_at_booking::text AS "priceRial"`,
      [grace],
    ),
  );
  const rows = ((updated as unknown as { rows: { id: string; accountId: string; priceRial: string }[] }).rows ?? []) as {
    id: string;
    accountId: string;
    priceRial: string;
  }[];

  for (const row of rows) {
    await deps.db.insert(reservationHistory).values({
      reservationId: row.id,
      fromStatus: 'Reserved',
      toStatus: 'NoShow',
      actorType: 'System',
      actorLabel: 'worker',
      note: 'عدم مراجعه پس از پایان فرجه',
    });
    await writeAudit(deps.db, {
      actor: { type: 'System', id: '', label: 'worker' },
      action: 'reservation.no_show',
      targetType: 'Reservation',
      targetId: row.id,
      details: { priceRial: Number(row.priceRial) },
    });
    await createNotification(deps.db, {
      title: 'عدم مراجعه به وعدهٔ غذایی',
      body: 'رزرو شما به دلیل مراجعه نکردن در بازهٔ تحویل، «عدم مراجعه» ثبت شد. مطابق سیاست سامانه، مبلغی بازگردانده نمی‌شود.',
      audience: 'Account',
      accountId: row.accountId,
      event: 'reservation.cancelled',
    });
  }
  return rows.length;
}

/** آیا رزرو در فهرست «فعال» نمایش داده می‌شود؟ */
export function isLiveStatus(status: string): boolean {
  return (LIVE_RESERVATION_STATUSES as readonly string[]).includes(status);
}
