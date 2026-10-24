import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { DEFAULT_SETTINGS } from '../db/seed.js';

export type Settings = typeof DEFAULT_SETTINGS & Record<string, unknown>;

export async function getSettings(db: Db | Tx): Promise<Settings> {
  const r = await db.execute<{ key: string; value: unknown }>(sql`SELECT key, value FROM system_settings`);
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of r.rows) out[row.key] = row.value;
  return out as Settings;
}
export const num = (s: Settings, k: string) => Number(s[k] ?? 0);
export const bool = (s: Settings, k: string) => s[k] === true;
