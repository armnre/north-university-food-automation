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
