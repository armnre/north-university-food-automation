import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, id, isActive, updatedAt } from './base.js';

/** کاتالوگ و منو: پیمانکاران، سلف‌ها، غذاها، وعده‌ها، آیتم‌های منو و قیمت هر گروه مشتری. */

export const contractors = pgTable(
  'contractors',
  {
    id: id(),
    name: varchar('name', { length: 150 }).notNull(),
    contractNumber: varchar('contract_number', { length: 80 }).notNull().default(''),
    contactPhone: varchar('contact_phone', { length: 30 }),
    contractFrom: date('contract_from'),
    contractTo: date('contract_to'),
    isActive: isActive(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('contractors_name_active_key')
      .on(t.name)
      .where(sql`${t.isActive} = true`),
    index('contractors_active_idx').on(t.isActive),
  ],
);

export const cafeterias = pgTable(
  'cafeterias',
  {
    id: id(),
    name: varchar('name', { length: 150 }).notNull(),
    location: varchar('location', { length: 200 }).notNull().default(''),
    contractorId: uuid('contractor_id').references(() => contractors.id, { onDelete: 'restrict' }),
    isActive: isActive(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('cafeterias_contractor_idx').on(t.contractorId), index('cafeterias_active_idx').on(t.isActive)],
);

export const foods = pgTable(
  'foods',
  {
    id: id(),
    name: varchar('name', { length: 150 }).notNull(),
    description: text('description').notNull().default(''),
    category: varchar('category', { length: 60 }).notNull().default(''),
    imagePath: varchar('image_path', { length: 1000 }),
    calories: integer('calories'),
    /** قیمت پیش‌فرض برای ساخت سریع منو (منبع حقیقت قیمت، `offering_prices` است). */
    defaultPriceRial: bigint('default_price_rial', { mode: 'number' }),
    defaultCapacity: integer('default_capacity'),
    isActive: isActive(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('foods_active_idx').on(t.isActive),
    index('foods_category_idx').on(t.category),
    check('foods_calories_check', sql`${t.calories} IS NULL OR ${t.calories} BETWEEN 0 AND 100000`),
    check('foods_default_price_check', sql`${t.defaultPriceRial} IS NULL OR ${t.defaultPriceRial} BETWEEN 0 AND 100000000`),
    check('foods_default_capacity_check', sql`${t.defaultCapacity} IS NULL OR ${t.defaultCapacity} BETWEEN 1 AND 100000`),
  ],
);

/** وعده‌های غذایی (صبحانه/ناهار/شام) با ساعت شروع و پایان به وقت تهران. */
export const mealSlots = pgTable(
  'meal_slots',
  {
    id: id(),
    /** Breakfast | Lunch | Dinner */
    code: varchar('code', { length: 20 }).notNull(),
    title: varchar('title', { length: 60 }).notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: isActive(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('meal_slots_code_key').on(t.code),
    check('meal_slots_code_check', sql`${t.code} IN ('Breakfast','Lunch','Dinner')`),
    check('meal_slots_time_check', sql`${t.endTime} > ${t.startTime}`),
  ],
);

/**
 * آیتم منو: یک غذا در یک روز سرویس، وعده و سلف، با ظرفیت و مهلت‌ها.
 * `reservedCount` به‌صورت اتمیک و فقط با `WHERE reserved_count < capacity` افزایش می‌یابد.
 */
export const mealOfferings = pgTable(
  'meal_offerings',
  {
    id: id(),
    /** روز سرویس = روز تقویمی تهران (نه timestamp). */
    serviceDate: date('service_date').notNull(),
    mealSlotId: uuid('meal_slot_id')
      .notNull()
      .references(() => mealSlots.id, { onDelete: 'restrict' }),
    foodId: uuid('food_id')
      .notNull()
      .references(() => foods.id, { onDelete: 'restrict' }),
    cafeteriaId: uuid('cafeteria_id')
      .notNull()
      .references(() => cafeterias.id, { onDelete: 'restrict' }),
    capacity: integer('capacity').notNull(),
    reservedCount: integer('reserved_count').notNull().default(0),
    reserveOpensAt: timestamp('reserve_opens_at', { withTimezone: true }).notNull(),
    reserveDeadline: timestamp('reserve_deadline', { withTimezone: true }).notNull(),
    cancelDeadline: timestamp('cancel_deadline', { withTimezone: true }),
    /** Draft | Published | Closed | Cancelled | SoldOut */
    status: varchar('status', { length: 20 }).notNull().default('Draft'),
    notes: text('notes').notNull().default(''),
    /** دلیل «تمام شد» یا «لغو وعده» (الزامی برای این دو عملیات). */
    statusReason: text('status_reason'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('meal_offerings_service_date_slot_idx').on(t.serviceDate, t.mealSlotId),
    index('meal_offerings_cafeteria_date_idx').on(t.cafeteriaId, t.serviceDate),
    index('meal_offerings_food_idx').on(t.foodId),
    index('meal_offerings_status_idx').on(t.status),
    // یک آیتم منو تکراری در یک روز/وعده/سلف/غذا ساخته نشود (مگر اینکه لغو شده باشد)
    uniqueIndex('meal_offerings_unique_slot_food')
      .on(t.serviceDate, t.mealSlotId, t.cafeteriaId, t.foodId)
      .where(sql`${t.status} <> 'Cancelled' AND ${t.deletedAt} IS NULL`),
    check('meal_offerings_capacity_positive', sql`${t.capacity} > 0`),
    check('meal_offerings_capacity_max', sql`${t.capacity} <= 100000`),
    check('meal_offerings_reserved_non_negative', sql`${t.reservedCount} >= 0`),
    check('meal_offerings_reserved_within_capacity', sql`${t.reservedCount} <= ${t.capacity}`),
    check('meal_offerings_status_check', sql`${t.status} IN ('Draft','Published','Closed','Cancelled','SoldOut')`),
    check('meal_offerings_deadline_order', sql`${t.reserveDeadline} >= ${t.reserveOpensAt}`),
  ],
);

/**
 * قیمت هر وعده برای هر گروه مشتری.
 * نبودِ ردیف برای یک گروه ⇒ آن گروه این غذا را نمی‌بیند و نمی‌تواند رزرو کند.
 */
export const offeringPrices = pgTable(
  'offering_prices',
  {
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => mealOfferings.id, { onDelete: 'cascade' }),
    /** Student | Employee | Faculty | Contractor */
    customerGroup: varchar('customer_group', { length: 20 }).notNull(),
    priceRial: bigint('price_rial', { mode: 'number' }).notNull(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    primaryKey({ columns: [t.offeringId, t.customerGroup] }),
    check('offering_prices_group_check', sql`${t.customerGroup} IN ('Student','Employee','Faculty','Contractor')`),
    check('offering_prices_price_non_negative', sql`${t.priceRial} >= 0`),
    check('offering_prices_price_max', sql`${t.priceRial} <= 100000000`),
  ],
);

/** تغییرات قیمت پس از انتشار (برای ممیزی و گزارش). */
export const offeringPriceHistory = pgTable(
  'offering_price_history',
  {
    id: id(),
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => mealOfferings.id, { onDelete: 'cascade' }),
    customerGroup: varchar('customer_group', { length: 20 }).notNull(),
    fromPriceRial: bigint('from_price_rial', { mode: 'number' }),
    toPriceRial: bigint('to_price_rial', { mode: 'number' }).notNull(),
    changedBy: uuid('changed_by'),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('offering_price_history_offering_idx').on(t.offeringId)],
);

export type MealOfferingRow = typeof mealOfferings.$inferSelect;
export type FoodRow = typeof foods.$inferSelect;
export type MealSlotRow = typeof mealSlots.$inferSelect;
