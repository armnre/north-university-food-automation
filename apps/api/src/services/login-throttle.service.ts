import { and, eq, lt, sql } from 'drizzle-orm';
import type { SubjectType } from '@food/shared';
import { loginAttempts } from '../db/schema/index.js';
import { sha256Hex } from '../lib/crypto.js';
import type { ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { verifyCaptcha } from './captcha.service.js';
import { AppError } from '../lib/errors.js';

/**
 * محدودیت تلاش ورود و تشدید به کپچا.
 *
 * تصمیم‌های پروژه:
 *  - قفل: ۵ تلاش ناموفق در ۱۵ دقیقه روی کلید **(identifier_hash + IP)**.
 *    چون کلید شامل IP است، کسی نمی‌تواند با تلاش عمدی، حساب دیگری را قفل کند.
 *  - شناسه‌های **ناموجود** دقیقاً مثل موجود شمارش و قفل می‌شوند (بدون افشای وجود حساب).
 *  - شمارندهٔ کل هر شناسه (از همهٔ IPها): از تلاش سوم کپچا اجباری؛
 *    بیش از ۳۰ شکست در ۱۵ دقیقه ⇒ کپچا برای همهٔ تلاش‌ها + رویداد `auth.suspicious`.
 *  - محدودیت IP فقط روی **شکست‌ها** و با آستانهٔ بالا (پیش‌فرض ۲۰۰ در ۱۵ دقیقه)
 *    و تشدید به کپچا، نه مسدودسازی سخت (شبکهٔ دانشگاه معمولاً NAT است).
 *  - ورود موفق، شمارش را برای آن (شناسه، IP) صفر می‌کند (شمارش فقط شکست‌های
 *    بعد از آخرین موفقیت).
 */

export const LOCK_THRESHOLD = 5;
export const LOCK_WINDOW_MINUTES = 15;
export const CAPTCHA_AFTER_IDENTIFIER_FAILURES = 3;
export const SUSPICIOUS_AFTER_IDENTIFIER_FAILURES = 30;

export type ThrottleCounts = {
  /** شکست‌های این شناسه از این IP (پس از آخرین موفقیت) */
  identifierIp: number;
  /** شکست‌های این شناسه از همهٔ IPها */
  identifier: number;
  /** شکست‌های این IP روی همهٔ شناسه‌ها */
  ip: number;
};

export type ThrottleDecision = {
  locked: boolean;
  captchaRequired: boolean;
  suspicious: boolean;
  counts: ThrottleCounts;
  retryAfterSeconds: number | null;
};

export type ThrottleSubject = { subjectType: SubjectType; identifier: string; ip: string };

export function identifierHashOf(subjectType: SubjectType, identifier: string): string {
  return sha256Hex(
    `login:${subjectType}:${String(identifier ?? '')
      .trim()
      .toLowerCase()}`,
  );
}

async function countFailures(deps: ServiceDeps, input: ThrottleSubject): Promise<ThrottleCounts> {
  const hash = identifierHashOf(input.subjectType, input.identifier);
  const ip = input.ip;
  const windowMinutes = LOCK_WINDOW_MINUTES;

  // یک پرس‌وجو، سه شمارنده. «پس از آخرین موفقیت» باعث می‌شود ورود موفق
  // شمارش شکست‌های قبلی همان (شناسه، IP) را بی‌اثر کند.
  const rows = await deps.db.execute(
    sql`
      SELECT
        (SELECT COUNT(*) FROM login_attempts la1
          WHERE la1.identifier_hash = ${hash} AND la1.ip = ${ip} AND la1.success = false
            AND la1.created_at > now() - make_interval(mins => ${windowMinutes})
            AND la1.created_at > COALESCE(
                  (SELECT MAX(la2.created_at) FROM login_attempts la2
                    WHERE la2.identifier_hash = ${hash} AND la2.ip = ${ip} AND la2.success = true),
                  '-infinity'::timestamptz)
        )::int AS identifier_ip,
        (SELECT COUNT(*) FROM login_attempts la3
          WHERE la3.identifier_hash = ${hash} AND la3.success = false
            AND la3.created_at > now() - make_interval(mins => ${windowMinutes})
        )::int AS identifier_total,
        (SELECT COUNT(*) FROM login_attempts la4
          WHERE la4.ip = ${ip} AND la4.success = false
            AND la4.created_at > now() - make_interval(mins => ${windowMinutes})
        )::int AS ip_total
    `,
  );

  const row = (rows as unknown as { rows: Record<string, number>[] }).rows?.[0] ?? {};
  return {
    identifierIp: Number(row.identifier_ip ?? 0),
    identifier: Number(row.identifier_total ?? 0),
    ip: Number(row.ip_total ?? 0),
  };
}

export function decide(counts: ThrottleCounts, deps: ServiceDeps): ThrottleDecision {
  const locked = counts.identifierIp >= LOCK_THRESHOLD;
  const ipEscalation = counts.ip >= deps.env.RATE_LIMIT_LOGIN_MAX;
  const suspicious = counts.identifier >= SUSPICIOUS_AFTER_IDENTIFIER_FAILURES;
  const captchaRequired = locked ? false : suspicious || ipEscalation || counts.identifier >= CAPTCHA_AFTER_IDENTIFIER_FAILURES;
  return {
    locked,
    captchaRequired,
    suspicious,
    counts,
    retryAfterSeconds: locked ? LOCK_WINDOW_MINUTES * 60 : null,
  };
}

/**
 * بررسی پیش از تلاش ورود: قفل ⇒ `LOCKED`، کپچای لازم ⇒ بررسی پاسخ.
 * برای شناسهٔ ناموجود هم دقیقاً همین مسیر اجرا می‌شود.
 */
export async function enforceLoginThrottle(
  deps: ServiceDeps,
  input: ThrottleSubject & { captchaId?: string | null; captchaAnswer?: string | null },
): Promise<ThrottleDecision> {
  const counts = await countFailures(deps, input);
  const decision = decide(counts, deps);

  if (decision.locked) {
    await writeAudit(deps.db, {
      actor: { type: 'Anonymous', id: '', label: '' },
      action: 'auth.locked',
      targetType: 'LoginAttempt',
      targetId: identifierHashOf(input.subjectType, input.identifier),
      details: { subjectType: input.subjectType, failures: counts.identifierIp },
      ip: input.ip,
    });
    throw new AppError('LOCKED', undefined, { retryAfterSeconds: decision.retryAfterSeconds }, 423);
  }

  if (decision.suspicious) {
    // فقط وقتی از آستانه عبور کردیم یک بار ثبت می‌شود (نه برای هر تلاش)
    if (counts.identifier === SUSPICIOUS_AFTER_IDENTIFIER_FAILURES) {
      await writeAudit(deps.db, {
        actor: { type: 'Anonymous', id: '', label: '' },
        action: 'auth.suspicious',
        targetType: 'LoginAttempt',
        targetId: identifierHashOf(input.subjectType, input.identifier),
        details: { subjectType: input.subjectType, failures: counts.identifier, distinctIpFailures: counts.ip },
        ip: input.ip,
      });
    }
  }

  if (decision.captchaRequired) {
    const verification = await verifyCaptcha(deps, { captchaId: input.captchaId, answer: input.captchaAnswer });
    if (!verification.ok) {
      throw new AppError(verification.ok ? 'CAPTCHA_INVALID' : verification.reason === 'missing' ? 'CAPTCHA_REQUIRED' : 'CAPTCHA_INVALID');
    }
  }

  return decision;
}

/** ثبت تلاش ناموفق. */
export async function recordLoginFailure(deps: ServiceDeps, input: ThrottleSubject): Promise<ThrottleDecision> {
  const hash = identifierHashOf(input.subjectType, input.identifier);
  await deps.db.insert(loginAttempts).values({
    identifierHash: hash,
    subjectType: input.subjectType,
    ip: input.ip.slice(0, 64),
    success: false,
  });
  const counts = await countFailures(deps, input);
  const decision = decide(counts, deps);
  if (decision.locked) {
    // ثبت لحظهٔ قفل روی آخرین تلاش ناموفق (برای گزارش و دیباگ؛ خودِ قفل
    // از شمارش پنجرهٔ لغزان محاسبه می‌شود)
    const latest = await deps.db
      .select({ id: loginAttempts.id })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.identifierHash, hash), eq(loginAttempts.ip, input.ip), eq(loginAttempts.success, false)))
      .orderBy(sql`${loginAttempts.createdAt} DESC`)
      .limit(1);
    if (latest[0]) {
      await deps.db
        .update(loginAttempts)
        .set({ lockedUntil: new Date(Date.now() + LOCK_WINDOW_MINUTES * 60_000) })
        .where(eq(loginAttempts.id, latest[0].id));
    }
  }
  return decision;
}

/** ثبت ورود موفق (شمارش شکست‌های بعدی از این نقطه شروع می‌شود). */
export async function recordLoginSuccess(deps: ServiceDeps, input: ThrottleSubject): Promise<void> {
  await deps.db.insert(loginAttempts).values({
    identifierHash: identifierHashOf(input.subjectType, input.identifier),
    subjectType: input.subjectType,
    ip: input.ip.slice(0, 64),
    success: true,
  });
}

/** پاک‌سازی رکوردهای قدیمی (job `cleanup`). */
export async function purgeLoginAttempts(deps: ServiceDeps, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await deps.db.delete(loginAttempts).where(lt(loginAttempts.createdAt, cutoff));
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}
