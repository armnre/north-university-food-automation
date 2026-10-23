import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { SubjectType } from '@food/shared';
import { sessions } from '../db/schema/index.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import type { ServiceDeps, Tx } from '../types.js';

/**
 * نشست‌ها.
 *
 *  - توکن ۲۵۶ بیتی تصادفی؛ در دیتابیس فقط SHA-256 آن ذخیره می‌شود.
 *  - انقضا: دانشجو/کارمند `SESSION_TTL_STUDENT_HOURS`، کارکنان `SESSION_TTL_STAFF_HOURS`.
 *  - تمدید لغزان در هر درخواست، با سقف مطلق `SESSION_ABSOLUTE_MAX_HOURS` (۷ روز).
 *  - ابطال دسته‌جمعی هنگام غیرفعال‌سازی، تغییر وضعیت دانشجو، ریست یا تغییر رمز.
 */

export function ttlHoursFor(deps: ServiceDeps, subjectType: SubjectType): number {
  return subjectType === 'Staff' ? deps.env.SESSION_TTL_STAFF_HOURS : deps.env.SESSION_TTL_STUDENT_HOURS;
}

export type SessionCreated = {
  token: string;
  sessionId: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

export async function createSession(
  target: Tx | ServiceDeps['db'],
  deps: ServiceDeps,
  input: { subjectType: SubjectType; subjectId: string; ip?: string; userAgent?: string },
): Promise<SessionCreated> {
  const token = randomHex(32); // 256 bit
  const now = Date.now();
  const ttlMs = ttlHoursFor(deps, input.subjectType) * 3_600_000;
  const absoluteMs = deps.env.SESSION_ABSOLUTE_MAX_HOURS * 3_600_000;
  const expiresAt = new Date(now + ttlMs);
  const absoluteExpiresAt = new Date(Math.min(now + ttlMs, now + absoluteMs));

  const [row] = await target
    .insert(sessions)
    .values({
      tokenHash: sha256Hex(token),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      ip: (input.ip ?? '').slice(0, 64) || null,
      userAgent: (input.userAgent ?? '').slice(0, 400) || null,
      expiresAt,
      absoluteExpiresAt,
      lastSeenAt: new Date(now),
    })
    .returning({ id: sessions.id, expiresAt: sessions.expiresAt, absoluteExpiresAt: sessions.absoluteExpiresAt });

  return { token, sessionId: row!.id, expiresAt: row!.expiresAt, absoluteExpiresAt: row!.absoluteExpiresAt };
}

export type ValidSession = typeof sessions.$inferSelect;

/** یافتن نشست معتبر از توکن خام؛ اگر نامعتبر/منقضی/باطل باشد `null`. */
export async function findValidSession(deps: ServiceDeps, token: string): Promise<ValidSession | null> {
  if (!token || token.length < 32) return null;
  const rows = await deps.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, sha256Hex(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        gt(sessions.absoluteExpiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * تمدید لغزان: اگر کمتر از نیمی از عمر نشست باقی مانده باشد، تا `now + ttl`
 * تمدید می‌شود (بدون عبور از سقف مطلق). `last_seen_at` همیشه به‌روز می‌شود.
 */
export async function touchSession(deps: ServiceDeps, session: ValidSession): Promise<void> {
  const now = new Date();
  const ttlMs = ttlHoursFor(deps, session.subjectType as SubjectType) * 3_600_000;
  const remainingMs = session.expiresAt.getTime() - now.getTime();
  const renewed =
    remainingMs < ttlMs / 2 ? new Date(Math.min(now.getTime() + ttlMs, session.absoluteExpiresAt.getTime())) : session.expiresAt;

  await deps.db.update(sessions).set({ lastSeenAt: now, expiresAt: renewed }).where(eq(sessions.id, session.id));
}

export async function revokeSessionByToken(deps: ServiceDeps, token: string, reason = 'logout'): Promise<boolean> {
  if (!token) return false;
  const rows = await deps.db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** ابطال همهٔ نشست‌های فعال یک سوژه. */
export async function revokeAllSessionsForSubject(
  target: Tx | ServiceDeps['db'],
  subjectType: SubjectType,
  subjectId: string,
  reason: string,
): Promise<number> {
  const rows = await target
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason.slice(0, 60) })
    .where(
      and(
        eq(sessions.subjectType, subjectType),
        eq(sessions.subjectId, subjectId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** ابطال همهٔ نشست‌ها به‌جز نشست جاری (پس از تغییر رمز). */
export async function revokeOtherSessions(
  target: Tx | ServiceDeps['db'],
  subjectType: SubjectType,
  subjectId: string,
  exceptSessionId: string | null,
  reason: string,
): Promise<number> {
  const conditions = [eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId), isNull(sessions.revokedAt)];
  if (exceptSessionId) conditions.push(sql`${sessions.id} <> ${exceptSessionId}`);
  const rows = await target
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason.slice(0, 60) })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listSessions(deps: ServiceDeps, subjectType: SubjectType, subjectId: string) {
  return deps.db
    .select({
      id: sessions.id,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.subjectType, subjectType),
        eq(sessions.subjectId, subjectId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(sessions.lastSeenAt);
}

export async function listRecentUserAgents(deps: ServiceDeps, subjectType: SubjectType, subjectId: string): Promise<string[]> {
  const rows = await deps.db
    .select({ userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId)))
    .orderBy(sql`${sessions.createdAt} DESC`)
    .limit(10);
  return rows.map((r) => r.userAgent ?? '').filter(Boolean);
}

export async function revokeSessionById(
  deps: ServiceDeps,
  sessionId: string,
  subjectType: SubjectType,
  subjectId: string,
  reason = 'user',
): Promise<boolean> {
  const rows = await deps.db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId), isNull(sessions.revokedAt)),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** پاک‌سازی نشست‌های منقضی/باطل قدیمی (job `cleanup`). */
export async function deleteExpiredSessions(deps: ServiceDeps, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await deps.db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, cutoff), and(sql`${sessions.revokedAt} IS NOT NULL`, lt(sessions.revokedAt, cutoff))));
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}
