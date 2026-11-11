import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Real PostgreSQL for integration tests. Uses TEST_DATABASE_ADMIN_URL (CI service container) when set,
 * otherwise boots embedded-postgres. Creates food_migrator/food_app roles exactly like deploy/provision.sh.
 */
let embedded: EmbeddedPostgres | undefined;

export async function setup() {
  if (!process.argv.some((a) => a.includes('integration'))) return;
  let admin = process.env.TEST_DATABASE_ADMIN_URL;
  if (!admin) {
    const port = 54330 + Math.floor(Math.random() * 500);
    embedded = new EmbeddedPostgres({
      databaseDir: `/tmp/food-pg-${port}`,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      createPostgresUser: true,
      onLog: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    admin = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  }
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query('DROP DATABASE IF EXISTS food_test');
  for (const r of ['food_app', 'food_migrator']) {
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r} LOGIN PASSWORD 'test'; END IF; END $$`);
  }
  await c.query('CREATE DATABASE food_test OWNER food_migrator');
  await c.end();
  const base = new URL(admin);
  const url = (user: string) => {
    const u = new URL(base);
    u.username = user;
    u.password = 'test';
    u.pathname = '/food_test';
    return u.toString();
  };
  // pgcrypto-free: gen_random_uuid is core in PG13+
  await runMigrations(url('food_migrator'));
  process.env.TEST_MIGRATOR_URL = url('food_migrator');
  process.env.TEST_DATABASE_URL = url('food_app');
}

export async function teardown() {
  await embedded?.stop();
}
