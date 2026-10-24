import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { captchas, loginAttempts } from '../db/schema.js';
import { hmac, randomInt, safeEqual, sha256 } from '../lib/crypto-ext.js';
import { audit } from './audit.js';

const WINDOW_MS = 15 * 60_000;
export const LIMITS = { lockPair: 5, captchaPair: 2, captchaIdentifier: 30, captchaIp: 200 } as const;

export type ThrottleState = { locked: boolean; captchaRequired: boolean };

/** Lock is keyed on (identifier_hash, ip) so nobody can lock someone else's account from another network. */
export async function throttleState(db: Db, identifierHash: string, ip: string): Promise<ThrottleState> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [r] = await db
    .select({
      pair: sql<number>`count(*) FILTER (WHERE ${loginAttempts.ip} = ${ip} AND ${loginAttempts.identifierHash} = ${identifierHash})::int`,
      ident: sql<number>`count(*) FILTER (WHERE ${loginAttempts.identifierHash} = ${identifierHash})::int`,
      byIp: sql<number>`count(*) FILTER (WHERE ${loginAttempts.ip} = ${ip})::int`,
    })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.success, false),
        gt(loginAttempts.createdAt, since),
        sql`(${loginAttempts.identifierHash} = ${identifierHash} OR ${loginAttempts.ip} = ${ip})`,
      ),
    );
  const pair = r?.pair ?? 0;
  const ident = r?.ident ?? 0;
  const byIp = r?.byIp ?? 0;
  return {
    locked: pair >= LIMITS.lockPair,
    captchaRequired: pair >= LIMITS.captchaPair || ident >= LIMITS.captchaIdentifier || byIp >= LIMITS.captchaIp,
  };
}

export async function recordAttempt(db: Db, identifierHash: string, ip: string, success: boolean) {
  await db.insert(loginAttempts).values({ identifierHash, ip, success });
  if (!success) {
    const since = new Date(Date.now() - WINDOW_MS);
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.identifierHash, identifierHash), eq(loginAttempts.success, false), gt(loginAttempts.createdAt, since)));
    if ((r?.n ?? 0) === LIMITS.captchaIdentifier + 1)
      await audit(db, { actor: 'system', action: 'auth.suspicious', entityType: 'Identifier', entityId: identifierHash.slice(0, 16), ip });
  } else {
    // a success clears the pair's failure streak by inserting a marker is unnecessary: lock counts only failures in window,
    // so delete this pair's recent failures (ephemeral table, DELETE is granted).
    await db.delete(loginAttempts).where(and(eq(loginAttempts.identifierHash, identifierHash), eq(loginAttempts.ip, ip), eq(loginAttempts.success, false)));
  }
}

export const identifierHash = (pepper: string, kind: string, identifier: string) => hmac(pepper, `login:${kind}:${identifier.toLowerCase()}`);

// ── self-made one-time captcha (SVG, no external service) ─────────────────
export async function createCaptcha(db: Db) {
  const a = randomInt(2, 10);
  const b = randomInt(1, 10);
  const answer = String(a + b);
  const [row] = await db
    .insert(captchas)
    .values({ answerHash: sha256(answer), expiresAt: new Date(Date.now() + 5 * 60_000) })
    .returning({ id: captchas.id });
  return { captchaId: row!.id, svg: captchaSvg(`${toFa(a)} + ${toFa(b)} = ?`) };
}

/** One-time: the row is consumed whether the answer is right or wrong. */
export async function verifyCaptcha(db: Db, id: string | undefined, answer: string | undefined): Promise<boolean> {
  if (!id || !answer || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await db
    .update(captchas)
    .set({ usedAt: new Date() })
    .where(and(eq(captchas.id, id), sql`${captchas.usedAt} IS NULL`, gt(captchas.expiresAt, new Date())))
    .returning({ answerHash: captchas.answerHash });
  if (!row) return false;
  const normalized = answer.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).trim();
  return safeEqual(row.answerHash, sha256(normalized));
}

const toFa = (n: number) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
function captchaSvg(text: string) {
  const noise = Array.from(
    { length: 6 },
    () => `<line x1="${randomInt(0, 160)}" y1="${randomInt(0, 50)}" x2="${randomInt(0, 160)}" y2="${randomInt(0, 50)}" stroke="#94a3b8" stroke-width="1"/>`,
  ).join('');
  const chars = [...text]
    .map(
      (c, i) =>
        `<text x="${14 + i * 14}" y="${30 + randomInt(-4, 5)}" font-size="22" font-family="sans-serif" fill="#0f172a" transform="rotate(${randomInt(-12, 13)} ${14 + i * 14} 30)">${c === '<' ? '&lt;' : c}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="50" viewBox="0 0 180 50"><rect width="180" height="50" fill="#f1f5f9"/>${noise}${chars}</svg>`;
}
