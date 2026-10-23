import { sql } from 'drizzle-orm';
import { formatFaDateTime, formatFaTime, isFutureServiceDate, isPastServiceDate, tehranToday } from '@food/shared';
import { deliveries, reservations, reservationHistory } from '../db/schema/index.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError, fail } from '../lib/errors.js';
import type { AuthContext, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';
import { computeScanWindow } from './reservation.service.js';
import { getSettings } from './settings.service.js';
import { rawSql } from '../db/raw.js';

/**
 * تحویل غذا در سلف.
 *
 * قواعد:
 *  - تحویل اتمیک: `UPDATE reservations SET status='Delivered' ... WHERE id=$1 AND status='Reserved' RETURNING`.
 *    صفر ردیف ⇒ «قبلاً تحویل شده» (دو اسکن هم‌زمان ⇒ فقط یک موفق).
 *  - هر تلاش (موفق/ناموفق) در `deliveries` ثبت می‌شود.
 *  - اعتبارسنجی: سلف اپراتور، روز تهران و بازهٔ اسکن.
 *  - `client_event_id` یکتا ⇒ idempotency برای صف آفلاین.
 */

export type ScanState =
  | 'ready'
  | 'delivered'
  | 'already'
  | 'cancelled'
  | 'invalid'
  | 'wrongCafeteria'
  | 'wrongDay'
  | 'expired'
  | 'outsideWindow'
  | 'noShow'
  | 'offlineConflict';

export type ScanInfo = {
  reservationId: string;
  code: string;
  holderName: string;
  holderIdentifier: string;
  customerGroup: string;
  foodName: string;
  mealSlot: string;
  serviceDate: string;
  cafeteriaName: string;
};

export type ScanResult = {
  state: ScanState;
  info: ScanInfo | null;
  message: string;
  deliveredAt: string | null;
  deliveredBy: string | null;
};

type Operator = { staffId: string; cafeteriaId: string | null; role: string; label: string };

export function operatorOf(auth: Extract<AuthContext, { kind: 'staff' }>): Operator {
  return { staffId: auth.staffId, cafeteriaId: auth.cafeteriaId, role: auth.role, label: auth.fullName || auth.username };
}

/** سلف مؤثر برای اپراتور: Operator فقط سلف خود؛ نقش‌های بالاتر همهٔ سلف‌ها. */
export function effectiveCafeteria(op: Operator): string | null {
  return op.role === 'Operator' ? (op.cafeteriaId ?? null) : null;
}

type RawReservation = {
  id: string;
  code: string;
  status: string;
  qrToken: string | null;
  serviceDate: string;
  mealSlot: string;
  slotStartTime: string;
  slotEndTime: string;
  foodName: string;
  cafeteriaId: string;
  cafeteriaName: string;
  holderName: string;
  holderIdentifier: string;
  customerGroup: string;
  deliveredAt: Date | null;
  deliveredByName: string | null;
};

/** یافتن رزرو از توکن QR (۴۸ hex) یا کد تحویل دستی (۸ کاراکتر، با/بدون «R-»). */
async function findReservation(target: Tx | ServiceDeps['db'], rawToken: string): Promise<RawReservation | null> {
  const token = String(rawToken ?? '').trim();
  if (!token) return null;

  const isQr = /^[a-f0-9]{48}$/i.test(token);
  let sqlFragment: string;
  let params: unknown[];
  if (isQr) {
    sqlFragment = `r.qr_token = $1`;
    params = [token.toLowerCase()];
  } else {
    const code = token
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/^R(?=[A-Z0-9]{8,12}$)/, '');
    if (!/^[A-Z0-9]{8,12}$/.test(code)) return null;
    sqlFragment = `r.code = $1`;
    params = [`R-${code}`];
  }

  const result = await target.execute(
    rawSql(
      `SELECT r.id, r.code, r.status, r.qr_token AS "qrToken", r.service_date AS "serviceDate",
              r.delivered_at AS "deliveredAt",
              ms.code AS "mealSlot", ms.start_time AS "slotStartTime", ms.end_time AS "slotEndTime",
              f.name AS "foodName", c.id AS "cafeteriaId", c.name AS "cafeteriaName",
              COALESCE(s.full_name, e.full_name) AS "holderName",
              COALESCE(s.student_number, e.username) AS "holderIdentifier",
              a.customer_group AS "customerGroup",
              u.full_name AS "deliveredByName"
       FROM reservations r
       JOIN meal_slots ms ON ms.id = r.meal_slot_id
       JOIN meal_offerings o ON o.id = r.offering_id
       JOIN foods f ON f.id = o.food_id
       JOIN cafeterias c ON c.id = r.cafeteria_id
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       LEFT JOIN staff_users u ON u.id = r.delivered_by
       WHERE ${sqlFragment}
       LIMIT 1`,
      params,
    ),
  );
  const row = ((result as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!row) return null;
  return {
    id: String(row.id),
    code: String(row.code ?? ''),
    status: String(row.status ?? ''),
    qrToken: row.qrToken == null ? null : String(row.qrToken),
    serviceDate: String(row.serviceDate ?? '').slice(0, 10),
    mealSlot: String(row.mealSlot ?? ''),
    slotStartTime: String(row.slotStartTime ?? ''),
    slotEndTime: String(row.slotEndTime ?? ''),
    foodName: String(row.foodName ?? ''),
    cafeteriaId: String(row.cafeteriaId ?? ''),
    cafeteriaName: String(row.cafeteriaName ?? ''),
    holderName: String(row.holderName ?? ''),
    holderIdentifier: String(row.holderIdentifier ?? ''),
    customerGroup: String(row.customerGroup ?? ''),
    deliveredAt: row.deliveredAt == null ? null : row.deliveredAt instanceof Date ? row.deliveredAt : new Date(String(row.deliveredAt)),
    deliveredByName: row.deliveredByName == null ? null : String(row.deliveredByName),
  };
}

function infoOf(row: RawReservation): ScanInfo {
  return {
    reservationId: row.id,
    code: row.code,
    holderName: row.holderName,
    holderIdentifier: row.holderIdentifier,
    customerGroup: row.customerGroup,
    foodName: row.foodName,
    mealSlot: row.mealSlot,
    serviceDate: row.serviceDate,
    cafeteriaName: row.cafeteriaName,
  };
}

/** نمایش کد تحویل بدون پیشوند داخلی. */
const showCode = (code: string) => code.replace(/^R-/, '');

async function logAttempt(
  target: Tx,
  input: {
    reservationId: string | null;
    operator: Operator;
    cafeteriaId: string | null;
    outcome: ScanStateToOutcome;
    message: string;
    clientEventId?: string | null;
    deviceId?: string;
    scannedAt?: Date | null;
    source?: 'Online' | 'OfflineSync';
  },
): Promise<void> {
  await target.insert(deliveries).values({
    reservationId: input.reservationId,
    operatorId: input.operator.staffId,
    cafeteriaId: input.cafeteriaId ?? (await fallbackCafeteria(target)),
    outcome: input.outcome,
    clientEventId: input.clientEventId || null,
    deviceId: (input.deviceId ?? '').slice(0, 120),
    source: input.source ?? 'Online',
    scannedAt: input.scannedAt ?? new Date(),
    message: input.message.slice(0, 500),
  });
}

type ScanStateToOutcome =
  'Accepted' | 'Duplicate' | 'Invalid' | 'WrongDay' | 'OutsideWindow' | 'Cancelled' | 'Expired' | 'WrongCafeteria' | 'OfflineConflict';

async function fallbackCafeteria(target: Tx | ServiceDeps['db']): Promise<string> {
  const rows = await target.execute(rawSql(`SELECT id FROM cafeterias ORDER BY is_active DESC, created_at ASC LIMIT 1`));
  const id = ((rows as unknown as { rows: { id: string }[] }).rows ?? [])[0]?.id;
  if (!id) fail('CONFLICT', 'هیچ سلفی در سامانه ثبت نشده است.');
  return id;
}

/** اعتبارسنجی اسکن بدون تحویل (نمایش نتیجه به اپراتور). */
export async function scanReservation(
  deps: ServiceDeps,
  input: { auth: Extract<AuthContext, { kind: 'staff' }>; qrToken: string; ip: string },
): Promise<ScanResult> {
  const op = operatorOf(input.auth);
  const settings = await getSettings(deps);
  const row = await findReservation(deps.db, input.qrToken);

  if (!row) {
    await deps.db.transaction(async (tx) => {
      await logAttempt(tx, {
        reservationId: null,
        operator: op,
        cafeteriaId: effectiveCafeteria(op),
        outcome: 'Invalid',
        message: 'کد نامعتبر',
      });
      await writeAudit(tx, {
        actor: { type: 'Staff', id: op.staffId, label: op.label },
        action: 'delivery.scan.invalid',
        targetType: 'QR',
        targetId: '',
        ip: input.ip,
      });
    });
    return {
      state: 'invalid',
      info: null,
      message: 'این کد در سامانه یافت نشد. کد را بررسی کنید یا دوباره اسکن کنید.',
      deliveredAt: null,
      deliveredBy: null,
    };
  }

  const evaluation = await evaluate(deps, row, op, settings);
  if (evaluation.state !== 'ready') {
    await deps.db.transaction(async (tx) => {
      await logAttempt(tx, {
        reservationId: row.id,
        operator: op,
        cafeteriaId: row.cafeteriaId,
        outcome: outcomeOf(evaluation.state),
        message: evaluation.message,
      });
    });
  }
  return {
    state: evaluation.state,
    info: infoOf(row),
    message: evaluation.message,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    deliveredBy: row.deliveredByName,
  };
}

function outcomeOf(state: ScanState): ScanStateToOutcome {
  switch (state) {
    case 'delivered':
    case 'already':
      return 'Duplicate';
    case 'cancelled':
      return 'Cancelled';
    case 'wrongDay':
      return 'WrongDay';
    case 'expired':
      return 'Expired';
    case 'outsideWindow':
      return 'OutsideWindow';
    case 'wrongCafeteria':
      return 'WrongCafeteria';
    case 'noShow':
      return 'Expired';
    case 'offlineConflict':
      return 'OfflineConflict';
    case 'invalid':
      return 'Invalid';
    default:
      return 'Accepted';
  }
}

type Evaluation = { state: ScanState; message: string };

async function evaluate(
  deps: ServiceDeps,
  row: RawReservation,
  op: Operator,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<Evaluation> {
  const today = tehranToday();

  if (row.status === 'Delivered') {
    return {
      state: 'already',
      message: `این وعده قبلاً در ${formatFaTime(row.deliveredAt ? row.deliveredAt.toISOString() : null)}${row.deliveredByName ? ` توسط ${row.deliveredByName}` : ''} تحویل شده است.`,
    };
  }
  if (row.status === 'Cancelled') return { state: 'cancelled', message: `رزرو ${showCode(row.code)} لغو شده است و قابل تحویل نیست.` };
  if (row.status === 'Rejected') return { state: 'invalid', message: 'این رزرو رد شده است.' };
  if (row.status === 'NoShow') return { state: 'noShow', message: 'این رزرو «عدم مراجعه» ثبت شده است و قابل تحویل نیست.' };
  if (row.status === 'Expired') return { state: 'expired', message: 'این رزرو منقضی شده است.' };

  const scopedCafeteria = effectiveCafeteria(op);
  if (scopedCafeteria && scopedCafeteria !== row.cafeteriaId) {
    return { state: 'wrongCafeteria', message: `این رزرو مربوط به «${row.cafeteriaName}» است و در سلف شما قابل تحویل نیست.` };
  }

  if (isPastServiceDate(row.serviceDate, new Date()))
    return { state: 'expired', message: 'این رزرو مربوط به روز گذشته است و تحویل داده نمی‌شود.' };
  if (isFutureServiceDate(row.serviceDate, new Date()))
    return { state: 'wrongDay', message: `این رزرو برای روز دیگری است (${row.serviceDate}).` };

  const window = computeScanWindow(row, settings);
  const now = new Date();
  if (now.getTime() < window.from.getTime()) {
    return { state: 'outsideWindow', message: `تحویل این وعده از ${formatFaDateTime(window.from)} آغاز می‌شود.` };
  }
  if (now.getTime() > window.to.getTime()) {
    return { state: 'outsideWindow', message: `بازهٔ تحویل این وعده در ${formatFaDateTime(window.to)} پایان یافته است.` };
  }

  void deps;
  void today;
  return { state: 'ready', message: `${row.holderName} — ${row.foodName} (${row.mealSlot})` };
}

/** تحویل قطعی: اتمیک و دقیقاً یک‌بار. */
export async function confirmDelivery(
  deps: ServiceDeps,
  input: {
    auth: Extract<AuthContext, { kind: 'staff' }>;
    qrToken: string;
    ip: string;
    clientEventId?: string | null;
    deviceId?: string;
    scannedAt?: string | null;
  },
): Promise<ScanResult> {
  const op = operatorOf(input.auth);
  const settings = await getSettings(deps);
  const clientEventId = input.clientEventId?.trim() || null;

  // idempotency سمت کلاینت: رویداد تکراری ⇒ همان نتیجهٔ قبلی
  if (clientEventId) {
    const existing = await deps.db.execute(
      rawSql(
        `SELECT d.outcome, d.message, d.reservation_id AS "reservationId", d.received_at AS "receivedAt" FROM deliveries d WHERE d.client_event_id = $1 LIMIT 1`,
        [clientEventId],
      ),
    );
    const row = ((existing as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
    if (row) {
      const reservation = row.reservationId ? await findReservation(deps.db, String(row.reservationId)) : null;
      const state: ScanState = String(row.outcome) === 'Accepted' ? 'delivered' : (mapOutcomeToState(String(row.outcome)) as ScanState);
      return {
        state,
        info: reservation ? infoOf(reservation) : null,
        message: String(row.message ?? 'این رویداد قبلاً ثبت شده است.'),
        deliveredAt: row.receivedAt ? new Date(String(row.receivedAt)).toISOString() : null,
        deliveredBy: op.label,
      };
    }
  }

  const row = await findReservation(deps.db, input.qrToken);
  if (!row) {
    await deps.db.transaction(async (tx) => {
      await logAttempt(tx, {
        reservationId: null,
        operator: op,
        cafeteriaId: effectiveCafeteria(op),
        outcome: 'Invalid',
        message: 'کد نامعتبر',
        clientEventId,
        deviceId: input.deviceId,
        scannedAt: input.scannedAt ? new Date(input.scannedAt) : null,
      });
    });
    return { state: 'invalid', info: null, message: 'این کد در سامانه یافت نشد.', deliveredAt: null, deliveredBy: null };
  }

  const evaluation = await evaluate(deps, row, op, settings);
  if (evaluation.state !== 'ready') {
    await deps.db.transaction(async (tx) => {
      await logAttempt(tx, {
        reservationId: row.id,
        operator: op,
        cafeteriaId: row.cafeteriaId,
        outcome: outcomeOf(evaluation.state),
        message: evaluation.message,
        clientEventId,
        deviceId: input.deviceId,
        scannedAt: input.scannedAt ? new Date(input.scannedAt) : null,
      });
    });
    return {
      state: evaluation.state,
      info: infoOf(row),
      message: evaluation.message,
      deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
      deliveredBy: row.deliveredByName,
    };
  }

  return deps.db.transaction(async (tx) => {
    // تحویل اتمیک: فقط اگر هنوز 'Reserved' باشد
    const updated = await tx
      .update(reservations)
      .set({ status: 'Delivered', deliveredAt: new Date(), deliveredBy: op.staffId })
      .where(sql`${reservations.id} = ${row.id} AND ${reservations.status} = 'Reserved'`)
      .returning({ id: reservations.id, deliveredAt: reservations.deliveredAt });

    if (updated.length === 0) {
      const fresh = await findReservation(tx, row.id);
      const message =
        fresh?.status === 'Delivered' ? 'این وعده هم‌اکنون توسط اپراتور دیگری تحویل داده شد.' : 'این رزرو در وضعیت تحویل‌پذیر نیست.';
      await logAttempt(tx, {
        reservationId: row.id,
        operator: op,
        cafeteriaId: row.cafeteriaId,
        outcome: 'Duplicate',
        message,
        clientEventId,
        deviceId: input.deviceId,
        scannedAt: input.scannedAt ? new Date(input.scannedAt) : null,
      });
      return {
        state: 'already' as ScanState,
        info: infoOf(row),
        message,
        deliveredAt: fresh?.deliveredAt ? fresh.deliveredAt.toISOString() : null,
        deliveredBy: fresh?.deliveredByName ?? null,
      };
    }

    await tx.insert(reservationHistory).values({
      reservationId: row.id,
      fromStatus: 'Reserved',
      toStatus: 'Delivered',
      actorType: 'Staff',
      actorId: op.staffId,
      actorLabel: op.label,
      note: 'تحویل در سلف',
    });

    const message = `${row.holderName} — ${row.foodName} تحویل داده شد.`;
    await logAttempt(tx, {
      reservationId: row.id,
      operator: op,
      cafeteriaId: row.cafeteriaId,
      outcome: 'Accepted',
      message,
      clientEventId,
      deviceId: input.deviceId,
      scannedAt: input.scannedAt ? new Date(input.scannedAt) : null,
    });

    await writeAudit(tx, {
      actor: { type: 'Staff', id: op.staffId, label: op.label },
      action: 'delivery.accept',
      targetType: 'Reservation',
      targetId: row.id,
      details: { cafeteriaId: row.cafeteriaId },
      ip: input.ip,
    });

    return {
      state: 'delivered' as ScanState,
      info: infoOf(row),
      message,
      deliveredAt: updated[0]!.deliveredAt ? updated[0]!.deliveredAt.toISOString() : new Date().toISOString(),
      deliveredBy: op.label,
    };
  });
}

function mapOutcomeToState(outcome: string): ScanState {
  switch (outcome) {
    case 'Duplicate':
      return 'already';
    case 'Invalid':
      return 'invalid';
    case 'WrongDay':
      return 'wrongDay';
    case 'OutsideWindow':
      return 'outsideWindow';
    case 'Cancelled':
      return 'cancelled';
    case 'Expired':
      return 'expired';
    case 'WrongCafeteria':
      return 'wrongCafeteria';
    case 'OfflineConflict':
      return 'offlineConflict';
    default:
      return 'delivered';
  }
}

/** آمار امروز و آخرین اسکن‌ها برای سلف جاری. */
export async function deliveryStats(deps: ServiceDeps, auth: Extract<AuthContext, { kind: 'staff' }>) {
  const op = operatorOf(auth);
  const scopedCafeteria = effectiveCafeteria(op);
  const today = tehranToday();

  const byMeal = await deps.db.execute(
    rawSql(
      `SELECT ms.code AS "mealSlot", ms.title,
              COUNT(r.id) FILTER (WHERE r.status IN ('Reserved','Delivered'))::int AS reserved,
              COUNT(r.id) FILTER (WHERE r.status = 'Delivered')::int AS delivered
       FROM meal_offerings o
       JOIN meal_slots ms ON ms.id = o.meal_slot_id
       LEFT JOIN reservations r ON r.offering_id = o.id
       WHERE o.service_date = $1::date ${scopedCafeteria ? 'AND o.cafeteria_id = $2::uuid' : ''}
       GROUP BY ms.code, ms.title, ms.sort_order
       ORDER BY ms.sort_order`,
      scopedCafeteria ? [today, scopedCafeteria] : [today],
    ),
  );

  const recent = await deps.db.execute(
    rawSql(
      `SELECT d.received_at AS at, r.code, d.outcome, d.message,
              COALESCE(s.full_name, e.full_name) AS "holderName",
              COALESCE(s.student_number, e.username) AS "holderIdentifier",
              f.name AS food, ms.code AS "mealSlot"
       FROM deliveries d
       LEFT JOIN reservations r ON r.id = d.reservation_id
       LEFT JOIN meal_offerings o ON o.id = r.offering_id
       LEFT JOIN meal_slots ms ON ms.id = r.meal_slot_id
       LEFT JOIN foods f ON f.id = o.food_id
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE d.cafeteria_id = $1::uuid AND d.received_at::date = $2::date
       ORDER BY d.received_at DESC
       LIMIT 20`,
      [scopedCafeteria ?? (await fallbackCafeteria(deps.db)), today],
    ),
  );

  const cafeteriaName = scopedCafeteria
    ? String(
        (
          (await deps.db.execute(rawSql(`SELECT name FROM cafeterias WHERE id = $1`, [scopedCafeteria]))) as unknown as {
            rows: { name: string }[];
          }
        ).rows?.[0]?.name ?? '',
      )
    : 'همهٔ سلف‌ها';

  const byMealRows = ((byMeal as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  const recentRows = ((recent as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];

  const totals = byMealRows.reduce<{ reserved: number; delivered: number }>(
    (acc, row) => ({
      reserved: acc.reserved + Number(row.reserved ?? 0),
      delivered: acc.delivered + Number(row.delivered ?? 0),
    }),
    { reserved: 0, delivered: 0 },
  );

  return {
    today,
    cafeteriaId: scopedCafeteria,
    cafeteriaName,
    scanWindow: null as { from: string; to: string } | null,
    byMeal: byMealRows.map((row) => ({
      mealSlot: String(row.mealSlot ?? ''),
      title: String(row.title ?? ''),
      reserved: Number(row.reserved ?? 0),
      delivered: Number(row.delivered ?? 0),
      remaining: Math.max(0, Number(row.reserved ?? 0) - Number(row.delivered ?? 0)),
    })),
    recent: recentRows.map((row) => ({
      at: new Date(String(row.at)).toISOString(),
      code: String(row.code ?? ''),
      holderName: String(row.holderName ?? ''),
      holderIdentifier: String(row.holderIdentifier ?? ''),
      food: String(row.food ?? ''),
      mealSlot: String(row.mealSlot ?? ''),
      outcome: String(row.outcome ?? ''),
    })),
    totals: {
      reserved: totals.reserved,
      delivered: totals.delivered,
      remaining: Math.max(0, totals.reserved - totals.delivered),
      rejected: recentRows.filter((r) => String(r.outcome) !== 'Accepted').length,
    },
  };
}

/**
 * فهرست آفلاین برای سلف: رزروهای `Reserved` امروزِ همان سلف با `sha256(token)`.
 * خود توکن هرگز به کلاینت داده نمی‌شود (فقط hash برای مقایسهٔ محلی).
 */
export async function offlineManifest(deps: ServiceDeps, auth: Extract<AuthContext, { kind: 'staff' }>, requestedCafeteriaId?: string) {
  const op = operatorOf(auth);
  // اپراتور فقط سلف خودش؛ نقش‌های دارای deliveryAll می‌توانند سلف را انتخاب کنند
  const scoped = effectiveCafeteria(op);
  let cafeteriaId = scoped;
  if (!cafeteriaId) {
    if (requestedCafeteriaId) {
      cafeteriaId = requestedCafeteriaId;
    } else {
      const first = await deps.db.execute(rawSql(`SELECT id FROM cafeterias WHERE is_active = true ORDER BY created_at LIMIT 1`));
      cafeteriaId = ((first as unknown as { rows: { id: string }[] }).rows ?? [])[0]?.id ?? null;
    }
  }
  if (!cafeteriaId) throw new AppError('NOT_FOUND', 'هیچ سلف فعالی برای دریافت فهرست آفلاین وجود ندارد.');
  const settings = await getSettings(deps);
  const today = tehranToday();

  const rows = await deps.db.execute(
    rawSql(
      `SELECT r.id, r.code, r.qr_token AS "qrToken", r.service_date AS "serviceDate",
              ms.code AS "mealSlot", ms.start_time AS "slotStartTime", ms.end_time AS "slotEndTime",
              f.name AS "foodName",
              COALESCE(s.full_name, e.full_name) AS "holderName",
              COALESCE(s.student_number, e.username) AS "holderIdentifier"
       FROM reservations r
       JOIN meal_offerings o ON o.id = r.offering_id
       JOIN meal_slots ms ON ms.id = r.meal_slot_id
       JOIN foods f ON f.id = o.food_id
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN students s ON s.id = a.student_id
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE r.status = 'Reserved' AND r.cafeteria_id = $1::uuid AND r.service_date = $2::date AND r.qr_token IS NOT NULL
       ORDER BY ms.sort_order, r.created_at`,
      [cafeteriaId, today],
    ),
  );

  const list = ((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  return {
    today,
    cafeteriaId,
    generatedAt: new Date().toISOString(),
    reservations: list.map((row) => {
      const windowRow = {
        serviceDate: String(row.serviceDate ?? '').slice(0, 10),
        slotStartTime: String(row.slotStartTime ?? ''),
        slotEndTime: String(row.slotEndTime ?? ''),
      };
      const window = computeScanWindow(windowRow, settings);
      return {
        reservationId: String(row.id),
        code: String(row.code ?? ''),
        qrTokenHash: sha256Hex(String(row.qrToken ?? '')),
        holderName: String(row.holderName ?? ''),
        holderIdentifier: String(row.holderIdentifier ?? ''),
        foodName: String(row.foodName ?? ''),
        mealSlot: String(row.mealSlot ?? ''),
        windowFrom: window.from.toISOString(),
        windowTo: window.to.toISOString(),
      };
    }),
  };
}

export type OfflineEvent = {
  clientEventId: string;
  reservationId: string;
  qrTokenHash: string;
  scannedAt: string;
  deviceId: string;
};

/**
 * همگام‌سازی صف آفلاین — idempotent.
 * سرور «برنده» را بر اساس وضعیت فعلی تعیین می‌کند:
 *  - اگر رزرو در فاصلهٔ آفلاین لغو شده باشد ⇒ `OfflineConflict` برای بررسی
 *  - اگر هم‌زمان سلف دیگری تحویل داده باشد ⇒ `OfflineConflict`
 *  - اگر hash توکن مطابقت نکند (QR بازصدور شده) ⇒ `Invalid`
 */
export async function syncOfflineScans(
  deps: ServiceDeps,
  input: { auth: Extract<AuthContext, { kind: 'staff' }>; events: OfflineEvent[]; ip: string },
): Promise<{
  accepted: number;
  duplicate: number;
  conflict: number;
  invalid: number;
  results: { clientEventId: string; outcome: string; message: string }[];
}> {
  const op = operatorOf(input.auth);
  const results: { clientEventId: string; outcome: string; message: string }[] = [];
  let accepted = 0;
  let duplicate = 0;
  let conflict = 0;
  let invalid = 0;

  for (const event of input.events.slice(0, 500)) {
    const outcome = await deps.db.transaction(async (tx) => {
      const existing = await tx.execute(
        rawSql(`SELECT id, outcome FROM deliveries WHERE client_event_id = $1 LIMIT 1`, [event.clientEventId]),
      );
      const existingRow = ((existing as unknown as { rows: { id: string; outcome: string }[] }).rows ?? [])[0];
      if (existingRow) {
        return { outcome: existingRow.outcome, message: 'این رویداد قبلاً ثبت شده است.', replay: true };
      }

      const reservation = await tx
        .select()
        .from(reservations)
        .where(sql`${reservations.id} = ${event.reservationId}`)
        .limit(1);
      const row = reservation[0];
      if (!row) return { outcome: 'Invalid', message: 'رزرو یافت نشد.' };

      const scopedCafeteria = effectiveCafeteria(op);
      if (scopedCafeteria && scopedCafeteria !== row.cafeteriaId) {
        return { outcome: 'WrongCafeteria', message: 'این رزرو مربوط به سلف دیگری است.' };
      }
      if (!row.qrToken || sha256Hex(row.qrToken) !== event.qrTokenHash) {
        return { outcome: 'Invalid', message: 'کد QR با فهرست آفلاین مطابقت ندارد (احتمالاً بازصدور شده است).' };
      }
      if (row.status === 'Cancelled') {
        await logAttempt(tx, {
          reservationId: row.id,
          operator: op,
          cafeteriaId: row.cafeteriaId,
          outcome: 'OfflineConflict',
          message: 'رزرو در فاصلهٔ آفلاین لغو شده است',
          clientEventId: event.clientEventId,
          deviceId: event.deviceId,
          scannedAt: new Date(event.scannedAt),
          source: 'OfflineSync',
        });
        return { outcome: 'OfflineConflict', message: 'این رزرو در فاصلهٔ قطعی اینترنت لغو شده است؛ برای بررسی به مسئول سلف مراجعه کنید.' };
      }
      if (row.status === 'Delivered') {
        await logAttempt(tx, {
          reservationId: row.id,
          operator: op,
          cafeteriaId: row.cafeteriaId,
          outcome: 'OfflineConflict',
          message: 'پیش‌تر توسط سلف دیگری تحویل شده است',
          clientEventId: event.clientEventId,
          deviceId: event.deviceId,
          scannedAt: new Date(event.scannedAt),
          source: 'OfflineSync',
        });
        return { outcome: 'OfflineConflict', message: 'این وعده پیش‌تر (احتمالاً توسط سلف دیگر) تحویل ثبت شده است.' };
      }
      if (row.status !== 'Reserved') {
        return { outcome: 'Invalid', message: `رزرو در وضعیت «${row.status}» قابل تحویل نیست.` };
      }

      const updated = await tx
        .update(reservations)
        .set({ status: 'Delivered', deliveredAt: new Date(event.scannedAt), deliveredBy: op.staffId })
        .where(sql`${reservations.id} = ${row.id} AND ${reservations.status} = 'Reserved'`)
        .returning({ id: reservations.id });

      if (updated.length === 0) {
        return { outcome: 'Duplicate', message: 'این وعده هم‌اکنون تحویل داده شد.' };
      }

      await tx.insert(reservationHistory).values({
        reservationId: row.id,
        fromStatus: 'Reserved',
        toStatus: 'Delivered',
        actorType: 'Staff',
        actorId: op.staffId,
        actorLabel: op.label,
        note: 'همگام‌سازی صف آفلاین',
      });
      await logAttempt(tx, {
        reservationId: row.id,
        operator: op,
        cafeteriaId: row.cafeteriaId,
        outcome: 'Accepted',
        message: 'تحویل از صف آفلاین',
        clientEventId: event.clientEventId,
        deviceId: event.deviceId,
        scannedAt: new Date(event.scannedAt),
        source: 'OfflineSync',
      });
      await writeAudit(tx, {
        actor: { type: 'Staff', id: op.staffId, label: op.label },
        action: 'delivery.offline_sync',
        targetType: 'Reservation',
        targetId: row.id,
        ip: input.ip,
      });
      return { outcome: 'Accepted', message: 'تحویل از صف آفلاین ثبت شد.' };
    });

    if (outcome.replay) duplicate += 1;
    else if (outcome.outcome === 'Accepted') accepted += 1;
    else if (outcome.outcome === 'Duplicate') duplicate += 1;
    else if (outcome.outcome === 'OfflineConflict') conflict += 1;
    else invalid += 1;
    results.push({ clientEventId: event.clientEventId, outcome: outcome.outcome, message: outcome.message });
  }

  return { accepted, duplicate, conflict, invalid, results };
}

/** گزارش مغایرت‌های آفلاین (برای مدیر ارشد). */
export async function listOfflineConflicts(deps: ServiceDeps, limit = 200) {
  const rows = await deps.db.execute(
    rawSql(
      `SELECT d.id, d.received_at AS "receivedAt", d.scanned_at AS "scannedAt", d.message, d.outcome,
              r.code AS "reservationCode", c.name AS "cafeteriaName", u.full_name AS "operatorName"
       FROM deliveries d
       LEFT JOIN reservations r ON r.id = d.reservation_id
       LEFT JOIN cafeterias c ON c.id = d.cafeteria_id
       LEFT JOIN staff_users u ON u.id = d.operator_id
       WHERE d.outcome = 'OfflineConflict'
       ORDER BY d.received_at DESC
       LIMIT $1`,
      [limit],
    ),
  );
  return (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    receivedAt: new Date(String(row.receivedAt)).toISOString(),
    scannedAt: new Date(String(row.scannedAt)).toISOString(),
    message: String(row.message ?? ''),
    outcome: String(row.outcome ?? ''),
    reservationCode: String(row.reservationCode ?? ''),
    cafeteriaName: String(row.cafeteriaName ?? ''),
    operatorName: String(row.operatorName ?? ''),
  }));
}
