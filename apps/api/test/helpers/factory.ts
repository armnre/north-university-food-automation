import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db/client.js';
import { accounts, employees, staffUsers, students } from '../../src/db/schema.js';
import { hashPassword } from '../../src/lib/password.js';
import { nationalIdHash } from '../../src/routes/auth.js';

export const PEPPER = 'p'.repeat(40);
let seq = 0;
export const uniq = () => `${Date.now() % 1e7}${++seq}`;

/** Generates a valid Iranian national id. */
export function nationalId(): string {
  for (;;) {
    const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
    const s = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
    const id = d.join('') + String(s < 2 ? s : 11 - s);
    if (!/^(\d)\1{9}$/.test(id)) return id;
  }
}

export async function makeStudent(db: Db, status: 'Active' | 'OnLeave' = 'Active') {
  const nid = nationalId();
  const sn = `40${uniq()}`;
  const [s] = await db
    .insert(students)
    .values({ studentNumber: sn, nationalIdHash: nationalIdHash(PEPPER, nid), nationalIdLast4: nid.slice(-4), firstName: 'سارا', lastName: 'احمدی', status })
    .returning();
  const [a] = await db.insert(accounts).values({ kind: 'Customer', studentId: s!.id }).returning();
  return { student: s!, account: a!, nid, sn };
}

export const STAFF_PASSWORD = 'Str0ng-Pass-123';
let pwHash: Promise<string> | undefined;
export async function makeStaff(db: Db, role: (typeof staffUsers.$inferInsert)['role'], extra: Partial<typeof staffUsers.$inferInsert> = {}) {
  const [u] = await db
    .insert(staffUsers)
    .values({
      username: `u${uniq()}`,
      fullName: 'کارمند',
      role,
      passwordHash: await (pwHash ??= hashPassword(STAFF_PASSWORD)),
      mustChangePassword: false,
      ...extra,
    })
    .returning();
  return u!;
}
export async function makeEmployee(db: Db, extra: Partial<typeof employees.$inferInsert> = {}) {
  const [e] = await db
    .insert(employees)
    .values({
      username: `e${uniq()}`,
      firstName: 'علی',
      lastName: 'رضایی',
      passwordHash: await (pwHash ??= hashPassword(STAFF_PASSWORD)),
      mustChangePassword: false,
      ...extra,
    })
    .returning();
  await db.insert(accounts).values({ kind: 'Customer', employeeId: e!.id });
  return e!;
}
export { randomUUID };

import { sql } from 'drizzle-orm';
import { postLedger, systemAccountId } from '../../src/services/ledger.js';
import { saveOffering } from '../../src/routes/offerings.js';
import { addDays, tehranDate } from '@food/shared';

export async function credit(db: Db, accountId: string, amount: bigint) {
  await db.transaction(async (tx) => {
    const cash = await systemAccountId(tx, 'manual-cash');
    await postLedger(tx, {
      type: 'MANUAL_CASH',
      idempotencyKey: `test-credit:${randomUUID()}`,
      actor: 'test',
      lines: [
        { accountId, amount },
        { accountId: cash, amount: -amount },
      ],
    });
  });
}

/** Published lunch offering `days` ahead (default tomorrow) with prices per group. */
export async function makeOffering(
  db: Db,
  o: { capacity?: number; student?: number; employee?: number | null; days?: number; deadlineMinutes?: number; cafeteriaId?: string } = {},
) {
  const food = (await db.execute<{ id: string }>(sql`INSERT INTO foods (name) VALUES (${`غذا ${uniq()}`}) RETURNING id`)).rows[0]!.id;
  const date = addDays(tehranDate(), o.days ?? 1);
  return db.transaction((tx) =>
    saveOffering(tx, 'test', {
      serviceDate: date,
      mealType: 'Lunch',
      foodId: food,
      cafeteriaId: o.cafeteriaId,
      capacity: o.capacity ?? 10,
      notes: '',
      active: true,
      reserveDeadline: new Date(Date.now() + (o.deadlineMinutes ?? 60) * 60_000).toISOString(),
      prices: { Student: o.student ?? 100_000, ...(o.employee === null ? {} : { Employee: o.employee ?? 150_000 }) },
    }),
  );
}
