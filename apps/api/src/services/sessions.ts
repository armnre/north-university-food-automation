import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export type SubjectType = 'student' | 'employee' | 'staff';
const HOUR = 3600_000;
export const IDLE_TTL: Record<SubjectType, number> = { student: 12 * HOUR, employee: 12 * HOUR, staff: 8 * HOUR };
export const ABSOLUTE_TTL = 7 * 24 * HOUR;

export async function createSession(db: Db, subjectType: SubjectType, subjectId: string, ip: string, userAgent: string | undefined) {
  const token = randomToken(32);
  const now = Date.now();
  const [row] = await db
    .insert(sessions)
    .values({
      tokenHash: sha256(token),
      subjectType,
      subjectId,
      ip,
      userAgent: userAgent?.slice(0, 300),
      expiresAt: new Date(now + IDLE_TTL[subjectType]),
      absoluteExpiresAt: new Date(now + ABSOLUTE_TTL),
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id };
}

/** Resolves a token and slides its idle expiry (capped by the absolute expiry). */
export async function resolveSession(db: Db, token: string) {
  const now = new Date();
  const [s] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now), gt(sessions.absoluteExpiresAt, now)))
    .limit(1);
  if (!s) return null;
  const type = s.subjectType as SubjectType;
  // only write when meaningfully stale to avoid a write per request
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
    const next = new Date(Math.min(now.getTime() + IDLE_TTL[type], s.absoluteExpiresAt.getTime()));
    await db.update(sessions).set({ lastSeenAt: now, expiresAt: next }).where(eq(sessions.id, s.id));
  }
  return { id: s.id, subjectType: type, subjectId: s.subjectId };
}

export const revokeSession = (db: Db, id: string) =>
  db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));

export async function revokeAllForSubject(db: Db, subjectType: SubjectType, subjectId: string, exceptSessionId?: string) {
  const r = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.subjectType, subjectType),
        eq(sessions.subjectId, subjectId),
        isNull(sessions.revokedAt),
        exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : undefined,
      ),
    )
    .returning({ id: sessions.id });
  return r.length;
}

export const listSessions = (db: Db, subjectType: SubjectType, subjectId: string) =>
  db
    .select({ id: sessions.id, ip: sessions.ip, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.subjectType, subjectType), eq(sessions.subjectId, subjectId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
