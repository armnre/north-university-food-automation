import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { eq, sql } from 'drizzle-orm';
import { createDb, createPool } from '../db/client.js';
import { auditLogs, staffUsers } from '../db/schema.js';
import { hashPassword, passwordPolicyError } from '../lib/password.js';

/** Creates the first SuperAdmin. Refuses if one exists. Password is read interactively, never from argv. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = createPool(url, 1);
const db = createDb(pool);
const [{ n } = { n: 0 }] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(staffUsers)
  .where(eq(staffUsers.role, 'SuperAdmin'));
if (n > 0) {
  console.error('A SuperAdmin already exists; refusing.');
  await pool.end();
  process.exit(1);
}
const rl = createInterface({ input: stdin, output: stdout });
const username = (await rl.question('username: ')).trim();
const fullName = (await rl.question('full name: ')).trim();
const password = process.env.ADMIN_PASSWORD ?? (await rl.question('password (min 10 chars): '));
rl.close();
const err = passwordPolicyError(password);
if (!username || !fullName || err) {
  console.error(err ?? 'username and full name are required');
  await pool.end();
  process.exit(1);
}
const [u] = await db
  .insert(staffUsers)
  .values({ username, fullName, role: 'SuperAdmin', passwordHash: await hashPassword(password), mustChangePassword: true })
  .returning({ id: staffUsers.id });
await db.insert(auditLogs).values({ actor: 'cli', action: 'staff.create-admin', entityType: 'StaffUser', entityId: u!.id });
await pool.end();
console.log('SuperAdmin created; password change is required at first login.');
