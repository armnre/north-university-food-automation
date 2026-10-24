import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** Migrations ship next to dist/ in the release bundle: <root>/drizzle */
export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("SET TIME ZONE 'UTC'");
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export async function pendingMigrations(url: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const journal = JSON.parse(await fs.readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query('SELECT created_at FROM drizzle.__drizzle_migrations').catch(() => ({ rows: [] as { created_at: string }[] }));
    const applied = new Set(r.rows.map((x) => Number(x.created_at)));
    return journal.entries.filter((e) => !applied.has(e.when)).map((e) => e.tag);
  } finally {
    await pool.end();
  }
}
