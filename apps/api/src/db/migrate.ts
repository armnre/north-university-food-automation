import { readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** مسیر پوشهٔ migration هم از `src` و هم از `dist` به‌درستی پیدا می‌شود. */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../drizzle'), resolve(here, '../../../drizzle')];
  for (const c of candidates) if (existsSync(resolve(c, 'meta/_journal.json'))) return c;
  throw new Error(`پوشهٔ migration یافت نشد: ${candidates.join(' , ')}`);
}

export type MigrateOptions = {
  /** اتصال مالک schema (نقش `food_migrator`). */
  connectionString: string;
  /** رمز نقش اجرایی؛ اگر تنظیم شود، نقش `food_app` LOGIN و رمزدار می‌شود. */
  appRolePassword?: string;
  appRole?: string;
  migratorRolePassword?: string;
  migratorRole?: string;
  log?: (message: string) => void;
};

/** فهرست migrationهای موجود (برای گزارش و `/api/ready`). */
export function listMigrations(): string[] {
  const folder = migrationsFolder();
  return readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** نسخهٔ اعمال‌شدهٔ دیتابیس (از جدول `__drizzle_migrations`). */
export async function appliedMigrationCount(connectionString: string): Promise<number> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
    );
    if (exists.rowCount === 0) return 0;
    const r = await client.query('SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations');
    return Number(r.rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

/**
 * اجرای migrationهای ورژن‌دار + تنظیم رمز نقش‌ها از env.
 * `drizzle-kit push` در این پروژه ممنوع است.
 */
export async function runMigrations(options: MigrateOptions): Promise<{ applied: number }> {
  const log = options.log ?? (() => undefined);
  const folder = migrationsFolder();
  const pool = new pg.Pool({ connectionString: options.connectionString, max: 1, application_name: 'food-migrator' });
  try {
    const db = drizzle(pool);
    log(`اجرای migrationها از ${folder}`);
    await migrate(db, { migrationsFolder: folder });

    // رمز نقش‌ها هیچ‌گاه در فایل SQL نیست؛ فقط از env خوانده و اعمال می‌شود.
    const client = await pool.connect();
    try {
      if (options.appRolePassword) {
        const role = options.appRole ?? 'food_app';
        await client.query(
          `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(options.appRolePassword)}`,
        );
        log(`رمز نقش ${role} تعیین شد.`);
      }
      if (options.migratorRolePassword) {
        const role = options.migratorRole ?? 'food_migrator';
        await client.query(
          `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(options.migratorRolePassword)}`,
        );
        log(`رمز نقش ${role} تعیین شد.`);
      }
    } finally {
      client.release();
    }

    const applied = await appliedMigrationCount(options.connectionString);
    return { applied };
  } finally {
    await pool.end();
  }
}
