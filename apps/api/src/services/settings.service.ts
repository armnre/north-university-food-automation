import { sql } from 'drizzle-orm';
import {
  DEFAULT_SETTINGS,
  resolveSettings,
  SETTINGS_META,
  validateSettingValue,
  type ResolvedSettings,
  type SettingKey,
} from '@food/shared';
import { systemSettings } from '../db/schema/index.js';
import type { Actor, ServiceDeps, Tx } from '../types.js';
import { writeAudit } from './audit.service.js';

/**
 * تنظیمات سامانه (`system_settings`).
 *
 * خواندن با کش کوتاه (۳۰ ثانیه) در حافظهٔ پروسه تا هر درخواست به دیتابیس نزند؛
 * پس از هر ویرایش کش بلافاصله پاک می‌شود.
 */
/**
 * کش کوتاه برای خواندن تنظیمات.
 * کلید کش **نمونهٔ db** است تا در تست‌ها (چند اپ با دیتابیس‌های مختلف)
 * مقدار یک نمونه به نمونهٔ دیگر نشت نکند.
 */
const CACHE_TTL_MS = 30_000;
const settingsCache = new WeakMap<object, { at: number; values: ResolvedSettings }>();

export async function loadSettingsRaw(target: Tx | ServiceDeps['db']): Promise<Partial<Record<SettingKey, string>>> {
  const rows = await target.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings);
  const out: Partial<Record<SettingKey, string>> = {};
  for (const row of rows) {
    const value = row.value;
    out[row.key as SettingKey] = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

export async function getSettings(deps: ServiceDeps, options: { fresh?: boolean } = {}): Promise<ResolvedSettings> {
  const now = Date.now();
  const cached = settingsCache.get(deps.db);
  if (!options.fresh && cached && now - cached.at < CACHE_TTL_MS) return cached.values;
  const raw = await loadSettingsRaw(deps.db);
  const values = resolveSettings(raw);
  settingsCache.set(deps.db, { at: now, values });
  return values;
}

/** پس از هر ویرایش، کش همان نمونه پاک می‌شود. */
export function invalidateSettingsCache(deps?: ServiceDeps): void {
  if (deps) settingsCache.delete(deps.db);
}

/** پاک‌کردن کش تنظیمات یک نمونهٔ db (برای تست‌ها و راه‌اندازی اپ). */
export function invalidateSettingsCacheForDb(db: object): void {
  settingsCache.delete(db);
}

/** کلیدهای عددی تنظیمات (برای مرزهای زمانی و سقف مبلغ). */
export type NumericSettingKey =
  | 'cancelCutoffHours'
  | 'noshowGraceMinutes'
  | 'scanWindowBeforeMinutes'
  | 'scanWindowAfterMinutes'
  | 'minGatewayPayableRial'
  | 'maxManualAdjustRial'
  | 'reminderHoursBeforeMeal';

export async function getSettingNumber(deps: ServiceDeps, key: NumericSettingKey): Promise<number> {
  const values = await getSettings(deps);
  return values[key];
}

export class SettingsValidationError extends Error {}

export type SettingsUpdateInput = {
  values?: Partial<Record<string, string | number | boolean>>;
  actor: Actor;
  ip?: string;
  userAgent?: string;
};

/**
 * به‌روزرسانی تنظیمات با اعتبارسنجی بازه و ثبت «قبل/بعد» در ممیزی.
 * دسترسی فقط با مجوز `settings` (یعنی SuperAdmin) — در route بررسی می‌شود.
 */
export async function updateSettings(
  deps: ServiceDeps,
  input: SettingsUpdateInput,
): Promise<{ values: ResolvedSettings; changed: string[] }> {
  const entries = Object.entries(input.values ?? {});
  if (entries.length === 0) return { values: await getSettings(deps), changed: [] };

  const before = await loadSettingsRaw(deps.db);
  const changed: string[] = [];
  const normalized: Record<string, string> = {};

  for (const [key, rawValue] of entries) {
    if (!(key in SETTINGS_META)) {
      throw new SettingsValidationError(`کلید «${key}» در تنظیمات سامانه تعریف نشده است.`);
    }
    const result = validateSettingValue(key as SettingKey, rawValue);
    if (!result.ok) throw new SettingsValidationError(result.messageFa);
    normalized[key] = result.value;
    const previous = before[key as SettingKey] ?? DEFAULT_SETTINGS[key as SettingKey];
    if (previous !== result.value) changed.push(key);
  }

  await deps.db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(normalized)) {
      await tx
        .insert(systemSettings)
        .values({ key, value: sql`to_jsonb(${value}::text)`, updatedBy: input.actor.type === 'Staff' ? input.actor.id : null })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: sql`to_jsonb(${value}::text)`, updatedBy: input.actor.type === 'Staff' ? input.actor.id : null },
        });
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: 'settings.update',
      targetType: 'SystemSettings',
      targetId: '',
      details: {
        changed,
        before: Object.fromEntries(changed.map((k) => [k, before[k as SettingKey] ?? ''])),
        after: Object.fromEntries(changed.map((k) => [k, normalized[k] ?? ''])),
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
  });

  invalidateSettingsCache(deps);
  return { values: await getSettings(deps, { fresh: true }), changed };
}
