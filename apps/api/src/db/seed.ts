import { sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS, MEAL_SLOT_DEFAULTS } from '@food/shared';
import type { Db, Tx } from './client.js';
import { cafeterias, mealSlots, systemSettings } from './schema/index.js';

/**
 * Seed **تولیدی**: فقط دادهٔ ساختاری لازم برای کار سامانه.
 *  - وعده‌های پیش‌فرض (صبحانه/ناهار/شام) — ساعت‌ها در صفحهٔ تنظیمات قابل ویرایش‌اند
 *  - مقدارهای پیش‌فرض `system_settings`
 *  - یک سلف مرکزی
 *
 * هیچ دادهٔ نمونه/دمو در production نوشته نمی‌شود. seed دمو فقط در development
 * و با پرچم صریح `ALLOW_DEMO_SEED=true` (فایل `seed-demo.ts`) انجام می‌شود.
 *
 * همهٔ عملیات idempotent است (onConflictDoNothing) و می‌توان چند بار اجرا شود.
 */
export type SeedResult = { mealSlots: number; settings: number; cafeteriaCreated: boolean };

export async function seedProduction(target: Db | Tx): Promise<SeedResult> {
  for (const slot of MEAL_SLOT_DEFAULTS) {
    await target
      .insert(mealSlots)
      .values({
        code: slot.code,
        title: slot.titleFa,
        startTime: slot.startTime,
        endTime: slot.endTime,
        sortOrder: slot.sortOrder,
      })
      .onConflictDoNothing();
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await target
      .insert(systemSettings)
      .values({ key, value: sql`to_jsonb(${value}::text)` })
      .onConflictDoNothing();
  }

  const existing = await target.select({ id: cafeterias.id }).from(cafeterias).limit(1);
  let cafeteriaCreated = false;
  if (existing.length === 0) {
    await target.insert(cafeterias).values({ name: 'سلف مرکزی', location: '', isActive: true });
    cafeteriaCreated = true;
  }

  return { mealSlots: MEAL_SLOT_DEFAULTS.length, settings: Object.keys(DEFAULT_SETTINGS).length, cafeteriaCreated };
}
