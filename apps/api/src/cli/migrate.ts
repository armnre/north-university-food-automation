import { pendingMigrations, runMigrations } from '../db/migrate.js';

const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATOR_DATABASE_URL is required');
  process.exit(2);
}
const pending = await pendingMigrations(url);
console.log(pending.length ? `pending migrations: ${pending.join(', ')}` : 'no pending migrations');
if (process.argv.includes('--list')) process.exit(0);
await runMigrations(url);
console.log('migrations applied');
