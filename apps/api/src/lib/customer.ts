import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import type { Customer } from '../services/reserve.js';
import { requirePrincipal } from './auth.js';
import { fail } from './errors.js';

/** Resolves the signed-in customer's account strictly from the session (never from input → no IDOR). */
export async function currentCustomer(db: Db, req: FastifyRequest): Promise<Customer & { subjectId: string }> {
  const p = requirePrincipal(req);
  if (p.subjectType === 'staff') fail('FORBIDDEN', 'این بخش مخصوص دانشجویان و کارکنان مشتری است.');
  const col = p.subjectType === 'student' ? sql`student_id` : sql`employee_id`;
  const r = await db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE ${col} = ${p.id}`);
  if (!r.rows[0]) fail('NOT_FOUND', 'حساب کاربری پیدا نشد.');
  return { accountId: r.rows[0].id, group: p.subjectType === 'student' ? 'Student' : 'Employee', actor: p.actor, subjectId: p.id };
}

export const MEAL_TYPE: Record<string, 'Breakfast' | 'Lunch' | 'Dinner'> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
export const n = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));
export const iso = (v: Date | string | null | undefined) => (v == null ? null : toDate(v).toISOString());

/** drizzle's node-postgres driver returns timestamptz from raw SQL as strings; normalise to Date. */
export function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const d = new Date(
    String(v)
      .replace(' ', 'T')
      .replace(/([+-]\d{2})$/, '$1:00'),
  );
  if (Number.isNaN(d.getTime())) throw new Error('invalid timestamp from db');
  return d;
}
export const toDateOrNull = (v: unknown) => (v == null ? null : toDate(v));
