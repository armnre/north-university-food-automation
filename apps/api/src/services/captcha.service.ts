import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { captchas } from '../db/schema/index.js';
import { createCaptcha, normalizeCaptchaAnswer, type CaptchaKind } from '../lib/captcha.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import type { ServiceDeps } from '../types.js';

/**
 * کپچای یک‌بارمصرفِ ساختِ خود سامانه (بدون وابستگی بیرونی).
 *
 *  - فقط hash پاسخ (HMAC با `CSRF_SECRET`) ذخیره می‌شود؛ پاسخ خام نه.
 *  - عمر ۵ دقیقه، حداکثر ۳ تلاش روی هر کپچا، پس از موفقیت `used_at` پر می‌شود.
 */

const CAPTCHA_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS_PER_CAPTCHA = 3;

export type IssuedCaptcha = {
  captchaId: string;
  kind: CaptchaKind;
  imageSvg: string;
  expiresAt: Date;
};

export async function issueCaptcha(deps: ServiceDeps, kind: CaptchaKind = 'Math'): Promise<IssuedCaptcha> {
  const challenge = createCaptcha(kind);
  const expiresAt = new Date(Date.now() + CAPTCHA_TTL_MS);
  const answerHash = hmacSha256Hex(deps.env.CSRF_SECRET, normalizeCaptchaAnswer(challenge.answer).toLowerCase());
  const [row] = await deps.db
    .insert(captchas)
    .values({ answerHash, kind: challenge.kind, expiresAt, attempts: 0 })
    .returning({ id: captchas.id });
  return { captchaId: row!.id, kind: challenge.kind, imageSvg: challenge.imageSvg, expiresAt };
}

export type CaptchaVerification = { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'used' | 'tooManyAttempts' };

/** بررسی پاسخ کپچا؛ در صورت موفقیت علامت مصرف می‌خورد (یک‌بارمصرف). */
export async function verifyCaptcha(
  deps: ServiceDeps,
  input: { captchaId?: string | null; answer?: string | null },
): Promise<CaptchaVerification> {
  if (!input.captchaId || !input.answer) return { ok: false, reason: 'missing' };

  const rows = await deps.db.select().from(captchas).where(eq(captchas.id, input.captchaId)).limit(1);
  const captcha = rows[0];
  if (!captcha) return { ok: false, reason: 'invalid' };
  if (captcha.usedAt) return { ok: false, reason: 'used' };
  if (captcha.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (captcha.attempts >= MAX_ATTEMPTS_PER_CAPTCHA) return { ok: false, reason: 'tooManyAttempts' };

  const expected = hmacSha256Hex(deps.env.CSRF_SECRET, normalizeCaptchaAnswer(input.answer).toLowerCase());
  if (expected !== captcha.answerHash) {
    await deps.db
      .update(captchas)
      .set({ attempts: sql`${captchas.attempts} + 1` })
      .where(eq(captchas.id, captcha.id));
    return { ok: false, reason: 'invalid' };
  }

  await deps.db
    .update(captchas)
    .set({ usedAt: new Date() })
    .where(and(eq(captchas.id, captcha.id), isNull(captchas.usedAt)));
  return { ok: true };
}

/** پاک‌سازی کپچاهای منقضی یا مصرف‌شدهٔ قدیمی (job `cleanup`). */
export async function deleteStaleCaptchas(deps: ServiceDeps, olderThanHours = 6): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const result = await deps.db
    .delete(captchas)
    .where(or(lt(captchas.expiresAt, cutoff), sql`${captchas.usedAt} IS NOT NULL AND ${captchas.usedAt} < ${cutoff}`));
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}

export const CAPTCHA_POLICY = { ttlMs: CAPTCHA_TTL_MS, maxAttempts: MAX_ATTEMPTS_PER_CAPTCHA };
