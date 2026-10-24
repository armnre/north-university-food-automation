import { createDb, createPool } from '../db/client.js';
import { seedProduction } from '../db/seed.js';

const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = createPool(url, 1);
await seedProduction(createDb(pool));
await pool.end();
console.log('production seed applied (idempotent)');
