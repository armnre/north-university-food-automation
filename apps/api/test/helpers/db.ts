import pg from 'pg';
import { createDb, createPool } from '../../src/db/client.js';
import { seedProduction } from '../../src/db/seed.js';

export function testPool(role: 'app' | 'migrator' = 'app') {
  const url = role === 'app' ? process.env.TEST_DATABASE_URL : process.env.TEST_MIGRATOR_URL;
  if (!url) throw new Error('integration DB not initialised');
  return createPool(url, 20);
}

export async function seeded() {
  const pool = testPool('migrator');
  await seedProduction(createDb(pool));
  await pool.end();
}

export async function expectPgError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as pg.DatabaseError;
    if (err.code === code) return err;
    throw new Error(`expected ${code}, got ${err.code}: ${err.message}`);
  }
  throw new Error(`expected pg error ${code}, but query succeeded`);
}
