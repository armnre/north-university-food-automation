import { sql } from 'drizzle-orm';
import { bigint, check, date, index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { accounts, staffUsers } from './identity.js';
import { cafeterias, mealOfferings, mealSlots } from './catalog.js';
import { createdAt, id, updatedAt } from './base.js';

/** رزرو، تاریخچهٔ تغییر وضعیت و لاگ همهٔ اسکن‌های تحویل. */

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    /** کد انسانی برای تحویل دستی (نمایش بدون پیشوند «R-»). */
    code: varchar('code', { length: 24 }).notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => mealOfferings.id, { onDelete: 'restrict' }),
    /**
     * denormalized از وعده: برای ایندکس یکتای جزئی «یک رزرو فعال در هر وعده»
     * و برای فیلترهای گزارش بدون join. سازگاری با trigger
     * `reservations_sync_denormalized` و `meal_offerings_protect_slot` تضمین می‌شود.
     */
    serviceDate: date('service_date').notNull(),
    mealSlotId: uuid('meal_slot_id')
      .notNull()
      .references(() => mealSlots.id, { onDelete: 'restrict' }),
    cafeteriaId: uuid('cafeteria_id')
      .notNull()
      .references(() => cafeterias.id, { onDelete: 'restrict' }),
    /** قیمت در لحظهٔ رزرو — تغییر قیمت بعدی روی رزروهای قبلی اثر ندارد. */
    priceAtBooking: bigint('price_at_booking', { mode: 'number' }).notNull(),
    customerGroupAtBooking: varchar('customer_group_at_booking', { length: 20 }).notNull(),
    /** Reserved | Delivered | Cancelled | Rejected | Expired | NoShow */
    status: varchar('status', { length: 20 }).notNull().default('Reserved'),
    /** کلید idempotency (ترکیب account + کلید کلاینت) — درخواست تکراری اثر دوم ندارد. */
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    /**
     * توکن تصادفی مات ۲۴ بایتی (۴۸ کاراکتر hex). هیچ اطلاعاتی را افشا نمی‌کند
     * و با بازصدور QR باطل می‌شود.
     */
    qrToken: varchar('qr_token', { length: 48 }),
    qrIssuedAt: timestamp('qr_issued_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveredBy: uuid('delivered_by').references(() => staffUsers.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    cancelledBy: uuid('cancelled_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reservations_code_key').on(t.code),
    uniqueIndex('reservations_idempotency_key').on(t.idempotencyKey),
    uniqueIndex('reservations_qr_token_key').on(t.qrToken),
    /** حداکثر یک رزرو فعال/تحویلی برای هر (حساب، آیتم منو) — چند غذای مختلف در یک وعده مجاز است */
    uniqueIndex('reservations_one_live_per_offering')
      .on(t.accountId, t.offeringId)
      .where(sql`${t.status} IN ('Reserved','Delivered')`),
    index('reservations_account_slot_idx').on(t.accountId, t.serviceDate, t.mealSlotId),
    index('reservations_account_status_idx').on(t.accountId, t.status),
    index('reservations_offering_status_idx').on(t.offeringId, t.status),
    index('reservations_service_date_idx').on(t.serviceDate, t.status),
    index('reservations_cafeteria_date_idx').on(t.cafeteriaId, t.serviceDate),
    index('reservations_created_at_idx').on(t.createdAt),
    check('reservations_status_check', sql`${t.status} IN ('Reserved','Delivered','Cancelled','Rejected','Expired','NoShow')`),
    check('reservations_group_check', sql`${t.customerGroupAtBooking} IN ('Student','Employee','Faculty','Contractor')`),
    check('reservations_price_non_negative', sql`${t.priceAtBooking} >= 0`),
    check('reservations_price_safe_range', sql`${t.priceAtBooking} <= 9000000000000000`),
    check('reservations_qr_token_shape', sql`${t.qrToken} IS NULL OR ${t.qrToken} ~ '^[a-f0-9]{48}$'`),
    check('reservations_code_shape', sql`${t.code} ~ '^R-[A-Z0-9]{8,12}$'`),
    check('reservations_cancel_requires_reason', sql`${t.status} <> 'Cancelled' OR ${t.cancelReason} IS NOT NULL`),
  ],
);

/** تاریخچهٔ تغییر وضعیت رزرو (append-only). */
export const reservationHistory = pgTable(
  'reservation_history',
  {
    id: id(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    fromStatus: varchar('from_status', { length: 20 }).notNull().default(''),
    toStatus: varchar('to_status', { length: 20 }).notNull(),
    actorType: varchar('actor_type', { length: 20 }).notNull().default('System'),
    actorId: uuid('actor_id'),
    actorLabel: varchar('actor_label', { length: 120 }).notNull().default(''),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('reservation_history_reservation_idx').on(t.reservationId, t.createdAt)],
);

/**
 * لاگ **همهٔ** تلاش‌های اسکن (موفق و ناموفق).
 * `client_event_id` برای همگام‌سازی آفلاین idempotent است.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: id(),
    reservationId: uuid('reservation_id').references(() => reservations.id, { onDelete: 'cascade' }),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'restrict' }),
    cafeteriaId: uuid('cafeteria_id')
      .notNull()
      .references(() => cafeterias.id, { onDelete: 'restrict' }),
    /** Accepted | Duplicate | Invalid | WrongDay | OutsideWindow | Cancelled | Expired | WrongCafeteria | OfflineConflict */
    outcome: varchar('outcome', { length: 24 }).notNull(),
    clientEventId: varchar('client_event_id', { length: 64 }),
    deviceId: varchar('device_id', { length: 120 }).notNull().default(''),
    /** Online | OfflineSync */
    source: varchar('source', { length: 20 }).notNull().default('Online'),
    /** زمان اسکن روی دستگاه کلاینت */
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
    /** زمان دریافت روی سرور */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    message: text('message').notNull().default(''),
  },
  (t) => [
    uniqueIndex('deliveries_client_event_id_key').on(t.clientEventId),
    index('deliveries_reservation_idx').on(t.reservationId),
    index('deliveries_cafeteria_received_idx').on(t.cafeteriaId, t.receivedAt),
    index('deliveries_operator_idx').on(t.operatorId, t.receivedAt),
    check(
      'deliveries_outcome_check',
      sql`${t.outcome} IN ('Accepted','Duplicate','Invalid','WrongDay','OutsideWindow','Cancelled','Expired','WrongCafeteria','OfflineConflict')`,
    ),
    check('deliveries_source_check', sql`${t.source} IN ('Online','OfflineSync')`),
  ],
);

export type ReservationRow = typeof reservations.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
