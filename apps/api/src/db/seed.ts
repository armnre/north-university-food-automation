import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { accounts, cafeterias, mealSlots, systemSettings } from './schema.js';

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  student_cancellation_enabled: false,
  cancel_cutoff_hours: 12,
  noshow_grace_minutes: 30,
  noshow_refund: false,
  scan_window_before_minutes: 60,
  scan_window_after_minutes: 60,
  min_gateway_payable_rial: 10000,
  online_payment_enabled: false,
  reminderHoursBeforeMeal: 2,
  max_manual_adjust_rial: 50000000,
  support_text: '',
  help_text: '',
  policy_text: '',
};

export const SYSTEM_ACCOUNTS = ['meal-revenue', 'payment-gateway', 'manual-cash', 'refund-credit'] as const;

/** Production seed: idempotent; only reference data, never demo people. */
export async function seedProduction(db: Db) {
  await db
    .insert(mealSlots)
    .values([
      { code: 'breakfast', title: 'صبحانه', startTime: '07:00', endTime: '09:00', sortOrder: 1 },
      { code: 'lunch', title: 'ناهار', startTime: '12:00', endTime: '14:30', sortOrder: 2 },
      { code: 'dinner', title: 'شام', startTime: '19:00', endTime: '21:00', sortOrder: 3 },
    ])
    .onConflictDoNothing();
  await db
    .insert(systemSettings)
    .values(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value, updatedBy: 'seed' })))
    .onConflictDoNothing();
  await db
    .insert(accounts)
    .values(SYSTEM_ACCOUNTS.map((code) => ({ kind: 'System' as const, code })))
    .onConflictDoNothing();
  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(cafeterias);
  if ((existing[0]?.n ?? 0) === 0) await db.insert(cafeterias).values({ name: 'سلف مرکزی' });
}
