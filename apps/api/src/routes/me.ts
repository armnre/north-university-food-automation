import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, tehranDate } from '@food/shared';
import type { Db } from '../db/client.js';
import { currentCustomer, iso, MEAL_TYPE, n, toDate } from '../lib/customer.js';
import { randomToken } from '../lib/crypto.js';
import { fail } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { cancelReservationInTx } from '../services/cancel.js';
import { reserve } from '../services/reserve.js';
import { bool, getSettings, num } from '../services/settings.js';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export function cancelDeadlineOf(o: { cancel_deadline: Date | null; meal_starts_at: Date }, cutoffHours: number): Date {
  return o.cancel_deadline ? toDate(o.cancel_deadline) : new Date(toDate(o.meal_starts_at).getTime() - cutoffHours * 3600_000);
}

export function meRoutes(app: FastifyInstance, db: Db) {
  const self = { config: { access: 'selfService' as const } };
  const reserveLimit = { config: { access: 'selfService' as const, rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/v1/me/menu', self, async (req) => {
    const c = await currentCustomer(db, req);
    const q = z.object({ from: z.string().regex(dateRe), to: z.string().regex(dateRe) }).parse(req.query);
    const today = tehranDate();
    const from = q.from < today ? today : q.from;
    const to = q.to > addDays(from, 31) ? addDays(from, 31) : q.to;
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT o.id, o.service_date, ms.code AS slot, f.name AS food_name, f.description AS food_description, f.image_path, cf.name AS cafeteria_name,
        p.price_rial, o.capacity, o.capacity - o.reserved_count AS remaining, o.reserve_deadline, o.reserve_opens_at, o.cancel_deadline, o.meal_starts_at, o.status,
        my.id AS my_id, my.status AS my_status,
        EXISTS (SELECT 1 FROM reservations r2 JOIN meal_offerings o2 ON o2.id = r2.offering_id
                WHERE r2.account_id = ${c.accountId} AND r2.status IN ('Reserved','Delivered') AND o2.service_date = o.service_date AND o2.meal_slot_id = o.meal_slot_id) AS slot_taken
      FROM meal_offerings o
      JOIN meal_slots ms ON ms.id = o.meal_slot_id JOIN foods f ON f.id = o.food_id JOIN cafeterias cf ON cf.id = o.cafeteria_id
      JOIN offering_prices p ON p.offering_id = o.id AND p.customer_group = ${c.group}
      LEFT JOIN reservations my ON my.offering_id = o.id AND my.account_id = ${c.accountId} AND my.status IN ('Reserved','Delivered')
      WHERE o.service_date BETWEEN ${from} AND ${to} AND o.status IN ('Published','SoldOut')
      ORDER BY o.service_date, ms.sort_order, f.name LIMIT 500`);
    const now = Date.now();
    return {
      today,
      offerings: r.rows.map((o) => ({
        id: o.id,
        serviceDate: o.service_date,
        mealType: MEAL_TYPE[o.slot as string] ?? o.slot,
        foodName: o.food_name,
        foodDescription: o.food_description ?? '',
        foodImage: o.image_path ? `/uploads/${o.image_path}` : null,
        cafeteriaName: o.cafeteria_name,
        priceRial: n(o.price_rial as bigint),
        capacity: o.capacity,
        remaining: Math.max(0, Number(o.remaining)),
        notes: '',
        reserveDeadline: iso(o.reserve_deadline as Date),
        cancelDeadline: iso(o.cancel_deadline as Date),
        open: o.status === 'Published' && toDate(o.reserve_deadline).getTime() > now && (!o.reserve_opens_at || toDate(o.reserve_opens_at).getTime() <= now),
        myReservationId: o.my_id ?? null,
        myStatus: o.my_status ?? null,
        slotTaken: !!o.slot_taken,
      })),
    };
  });

  app.post('/api/v1/me/reserve', reserveLimit, async (req) => {
    const c = await currentCustomer(db, req);
    const b = z.object({ offeringId: z.string().uuid(), idempotencyKey: z.string().min(8).max(80) }).parse(req.body);
    const r = await reserve(db, c, b.offeringId, `${c.accountId}:${b.idempotencyKey}`);
    return { reservationId: r.reservationId, code: r.code, replay: r.replay };
  });

  app.get('/api/v1/me/reservations', self, async (req) => {
    const c = await currentCustomer(db, req);
    const s = await getSettings(db);
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT r.id, r.code, r.status, r.price_rial, r.created_at, r.delivered_at, r.qr_token, o.service_date, ms.code AS slot, f.name AS food_name, cf.name AS cafeteria_name,
        o.cancel_deadline, o.meal_starts_at, o.meal_ends_at
      FROM reservations r JOIN meal_offerings o ON o.id = r.offering_id JOIN meal_slots ms ON ms.id = o.meal_slot_id
      JOIN foods f ON f.id = o.food_id JOIN cafeterias cf ON cf.id = o.cafeteria_id
      WHERE r.account_id = ${c.accountId} AND r.status <> 'Rejected' ORDER BY o.service_date DESC, ms.sort_order DESC LIMIT 300`);
    const now = Date.now();
    const enabled = bool(s, 'student_cancellation_enabled');
    const cutoff = num(s, 'cancel_cutoff_hours');
    return {
      today: tehranDate(),
      cancellationEnabled: enabled,
      reservations: r.rows.map((x) => {
        const deadline = cancelDeadlineOf({ cancel_deadline: x.cancel_deadline as Date | null, meal_starts_at: x.meal_starts_at as Date }, cutoff);
        const active = x.status === 'Reserved';
        return {
          id: x.id,
          code: String(x.code).replace(/^R-/, ''),
          status: x.status,
          priceAtBooking: n(x.price_rial as bigint),
          createdAt: iso(x.created_at as Date),
          serviceDate: x.service_date,
          mealType: MEAL_TYPE[x.slot as string] ?? x.slot,
          foodName: x.food_name,
          cafeteriaName: x.cafeteria_name,
          deliveredAt: iso(x.delivered_at as Date),
          cancelDeadline: deadline.toISOString(),
          canCancel: enabled && active && deadline.getTime() > now,
          qrToken: active ? x.qr_token : null,
        };
      }),
    };
  });

  app.post('/api/v1/me/reservations/:id/cancel', self, async (req) => {
    const c = await currentCustomer(db, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = await getSettings(db);
    if (!bool(s, 'student_cancellation_enabled')) fail('FORBIDDEN', 'لغو رزرو توسط دانشجو در حال حاضر غیرفعال است.');
    return db.transaction(async (tx) => {
      const r = await tx.execute<{ cancel_deadline: Date | null; meal_starts_at: Date; status: string }>(sql`
        SELECT o.cancel_deadline, o.meal_starts_at, r.status FROM reservations r JOIN meal_offerings o ON o.id = r.offering_id
        WHERE r.id = ${id} AND r.account_id = ${c.accountId} FOR UPDATE OF r`);
      const row = r.rows[0];
      if (!row) fail('NOT_FOUND', 'رزرو پیدا نشد.');
      if (row.status === 'Cancelled') return { ok: true, refundRial: 0, replay: true };
      if (cancelDeadlineOf(row, num(s, 'cancel_cutoff_hours')).getTime() <= Date.now()) fail('BAD_REQUEST', 'مهلت لغو این رزرو گذشته است.');
      const out = await cancelReservationInTx(tx, id, c.actor, 'لغو توسط مشتری');
      await tx.execute(
        sql`INSERT INTO notifications (account_id, title, body, kind) VALUES (${c.accountId}, 'لغو رزرو', ${`رزرو شما لغو شد و مبلغ ${out.refund.toString()} ریال به اعتبار شما برگشت.`}, 'refund')`,
      );
      return { ok: true, refundRial: n(out.refund), replay: false };
    });
  });

  app.post('/api/v1/me/reservations/:id/reissue-qr', self, async (req) => {
    const c = await currentCustomer(db, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.execute<{ qr_token: string }>(
      sql`UPDATE reservations SET qr_token = ${randomToken(24)}, updated_at = now() WHERE id = ${id} AND account_id = ${c.accountId} AND status = 'Reserved' RETURNING qr_token`,
    );
    if (!r.rows[0]) fail('NOT_FOUND', 'رزرو فعال پیدا نشد.');
    await audit(db, { actor: c.actor, action: 'reservation.reissue-qr', entityType: 'Reservation', entityId: id });
    return { qrToken: r.rows[0].qr_token };
  });

  app.get('/api/v1/me/wallet', self, async (req) => {
    const c = await currentCustomer(db, req);
    const bal = await db.execute<{ balance_rial: bigint }>(sql`SELECT balance_rial FROM accounts WHERE id = ${c.accountId}`);
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT e.id, t.tracking_code, t.type, e.amount_rial, t.reason, e.created_at, e.balance_after
      FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE e.account_id = ${c.accountId} ORDER BY e.created_at DESC, e.id DESC LIMIT 500`);
    return {
      balanceRial: n(bal.rows[0]?.balance_rial),
      transactions: r.rows.map((x) => ({
        id: x.id,
        trackingCode: x.tracking_code,
        type: x.type,
        amountRial: n(x.amount_rial as bigint),
        reason: x.reason ?? '',
        createdAt: iso(x.created_at as Date),
        runningBalance: n(x.balance_after as bigint),
      })),
    };
  });

  app.get('/api/v1/me/notifications', self, async (req) => {
    const c = await currentCustomer(db, req);
    const aud = c.group === 'Student' ? 'students' : 'employees';
    const r = await db.execute<Record<string, unknown>>(sql`
      SELECT id, title, body, created_at, account_id IS NOT NULL AS personal FROM notifications
      WHERE account_id = ${c.accountId} OR (account_id IS NULL AND audience IN ('all', ${aud})) ORDER BY created_at DESC LIMIT 100`);
    const s = await getSettings(db);
    return {
      notifications: r.rows.map((x) => ({ id: x.id, title: x.title, body: x.body, createdAt: iso(x.created_at as Date), personal: !!x.personal })),
      supportText: String(s.support_text ?? ''),
      helpText: String(s.help_text ?? ''),
    };
  });

  app.get('/api/v1/me/profile', self, async (req) => {
    const c = await currentCustomer(db, req);
    const r = await db.execute<
      Record<string, unknown>
    >(sql`SELECT a.balance_rial, s.student_number, s.first_name AS sf, s.last_name AS sl, s.faculty, s.major, s.national_id_last4, s.last_login_at AS sll,
      e.username, e.first_name AS ef, e.last_name AS el, e.kind, e.last_login_at AS ell FROM accounts a LEFT JOIN students s ON s.id=a.student_id LEFT JOIN employees e ON e.id=a.employee_id WHERE a.id=${c.accountId}`);
    const x = r.rows[0]!;
    const prev = await db.execute<{ created_at: string }>(
      sql`SELECT created_at FROM sessions WHERE subject_id=${c.subjectId} ORDER BY created_at DESC OFFSET 1 LIMIT 1`,
    );
    return {
      customerGroup: c.group,
      balanceRial: n(x.balance_rial as bigint),
      fullName: c.group === 'Student' ? `${x.sf} ${x.sl}` : `${x.ef} ${x.el}`,
      studentNumber: (x.student_number as string | null) ?? null,
      username: (x.username as string | null) ?? null,
      faculty: (x.faculty as string | null) ?? '',
      major: (x.major as string | null) ?? '',
      nationalIdMasked: x.national_id_last4 ? `******${x.national_id_last4}` : null,
      previousLoginAt: prev.rows[0] ? iso(prev.rows[0].created_at) : null,
    };
  });
}
