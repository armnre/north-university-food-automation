import type { AppEnv } from '../../src/config/env.js';
import type { Db } from '../../src/db/client.js';
import { captchas } from '../../src/db/schema/index.js';
import { hmacSha256Hex } from '../../src/lib/crypto.js';

/**
 * ساخت کپچا با پاسخ شناخته‌شده برای تست.
 * (پاسخ کپچای تولیدشده توسط سرویس قابل استخراج نیست — همان‌طور که باید باشد؛
 * بنابراین برای تستِ «پاسخ صحیح پذیرفته می‌شود» یک کپچا با hash شناخته‌شده درج می‌کنیم.)
 */
export async function issueCaptchaForTest(db: Db, env: AppEnv, answer = '42'): Promise<{ captchaId: string; answer: string }> {
  const [row] = await db
    .insert(captchas)
    .values({
      answerHash: hmacSha256Hex(env.CSRF_SECRET, answer),
      kind: 'Math',
      expiresAt: new Date(Date.now() + 5 * 60_000),
      attempts: 0,
    })
    .returning({ id: captchas.id });
  return { captchaId: row!.id, answer };
}
