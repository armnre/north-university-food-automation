import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { expectPgError, seeded, testPool } from '../helpers/db.js';

let app: pg.Pool;
let mig: pg.Pool;
beforeAll(async () => {
  await seeded();
  app = testPool('app');
  mig = testPool('migrator');
});
afterAll(async () => {
  await app.end();
  await mig.end();
});

async function student(n: string) {
  const r = await app.query(
    `INSERT INTO students (student_number, national_id_hash, national_id_last4, first_name, last_name) VALUES ($1, $2, '1234', 'الف', 'ب') RETURNING id`,
    [n, `h-${n}`],
  );
  const a = await app.query(`INSERT INTO accounts (kind, student_id) VALUES ('Customer', $1) RETURNING id`, [r.rows[0].id]);
  return { studentId: r.rows[0].id as string, accountId: a.rows[0].id as string };
}
async function offering(capacity = 5) {
  const slot = (await app.query(`SELECT id FROM meal_slots WHERE code='lunch'`)).rows[0].id;
  const cafe = (await app.query(`SELECT id FROM cafeterias LIMIT 1`)).rows[0].id;
  const food = (await app.query(`INSERT INTO foods (name) VALUES ('چلو کباب') RETURNING id`)).rows[0].id;
  return (
    await app.query(
      `INSERT INTO meal_offerings (service_date, meal_slot_id, food_id, cafeteria_id, capacity, reserve_deadline, meal_starts_at, meal_ends_at)
    VALUES ('2030-01-01', $1, $2, $3, $4, '2030-01-01T06:00Z', '2030-01-01T08:30Z', '2030-01-01T11:00Z') RETURNING id`,
      [slot, food, cafe, capacity],
    )
  ).rows[0].id as string;
}

describe('schema constraints on real PostgreSQL', () => {
  it('seed is idempotent and creates slots, settings and system accounts', async () => {
    await seeded();
    expect((await app.query(`SELECT count(*)::int n FROM meal_slots`)).rows[0].n).toBe(3);
    expect((await app.query(`SELECT count(*)::int n FROM accounts WHERE kind='System'`)).rows[0].n).toBe(4);
    expect((await app.query(`SELECT value FROM system_settings WHERE key='student_cancellation_enabled'`)).rows[0].value).toBe(false);
  });

  it('student number and national id hash are unique', async () => {
    await student('1001');
    await expectPgError(student('1001'), '23505');
    await expectPgError(
      app.query(`INSERT INTO students (student_number, national_id_hash, national_id_last4, first_name, last_name) VALUES ('1002','h-1001','1234','a','b')`),
      '23505',
    );
  });

  it('customer balance cannot go negative', async () => {
    const s = await student('1003');
    await expectPgError(app.query(`UPDATE accounts SET balance_rial = -1 WHERE id = $1`, [s.accountId]), '23514');
  });

  it('capacity checks hold', async () => {
    const o = await offering(2);
    await expectPgError(app.query(`UPDATE meal_offerings SET reserved_count = 3 WHERE id = $1`, [o]), '23514');
    await expectPgError(app.query(`UPDATE meal_offerings SET capacity = 0 WHERE id = $1`, [o]), '23514');
  });

  it('partial unique index allows one active reservation per account+offering, re-reserve after cancel', async () => {
    const s = await student('1004');
    const o = await offering();
    const ins = (k: string) =>
      app.query(
        `INSERT INTO reservations (code, account_id, offering_id, customer_group, price_rial, idempotency_key, qr_token) VALUES ($1,$2,$3,'Student',100,$1,$1) RETURNING id`,
        [k, s.accountId, o],
      );
    const r1 = await ins('k1');
    await expectPgError(ins('k2'), '23505');
    await app.query(`UPDATE reservations SET status='Cancelled' WHERE id=$1`, [r1.rows[0].id]);
    await ins('k3');
    // a different food in the same meal is allowed
    await app.query(
      `INSERT INTO reservations (code, account_id, offering_id, customer_group, price_rial, idempotency_key, qr_token) VALUES ('k4',$1,$2,'Student',100,'k4','k4')`,
      [s.accountId, await offering()],
    );
  });

  it('unbalanced ledger transaction is rejected at commit; balanced succeeds', async () => {
    const s = await student('1005');
    const rev = (await app.query(`SELECT id FROM accounts WHERE code='meal-revenue'`)).rows[0].id;
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      const tx = (
        await c.query(`INSERT INTO ledger_transactions (type, idempotency_key, tracking_code, actor) VALUES ('Test','u1','T-u1','test') RETURNING id`)
      ).rows[0].id;
      await c.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount_rial, balance_after) VALUES ($1,$2,500,500)`, [tx, s.accountId]);
      await expectPgError(c.query('COMMIT'), '23514');
    } finally {
      c.release();
    }
    const c2 = await app.connect();
    await c2.query('BEGIN');
    const tx = (await c2.query(`INSERT INTO ledger_transactions (type, idempotency_key, tracking_code, actor) VALUES ('Test','b1','T-b1','test') RETURNING id`))
      .rows[0].id;
    await c2.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount_rial, balance_after) VALUES ($1,$2,500,500), ($1,$3,-500,-500)`, [
      tx,
      s.accountId,
      rev,
    ]);
    await c2.query('COMMIT');
    c2.release();
  });

  it('ledger and audit are append-only (GRANT for food_app, trigger even for owner)', async () => {
    await app.query(`INSERT INTO audit_logs (actor, action) VALUES ('t','x')`);
    await expectPgError(app.query(`UPDATE audit_logs SET action='y'`), '42501');
    await expectPgError(app.query(`DELETE FROM ledger_entries`), '42501');
    await expectPgError(mig.query(`UPDATE audit_logs SET action='y'`), '42501');
    await expectPgError(mig.query(`DELETE FROM ledger_transactions`), '42501');
    await expectPgError(mig.query(`TRUNCATE audit_logs`), '42501');
  });

  it('food_app cannot physically delete business rows', async () => {
    await expectPgError(app.query(`DELETE FROM students`), '42501');
  });
});
