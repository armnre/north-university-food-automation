import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppEnv } from '../config/env.js';

/**
 * کوکی‌ها و CSRF (double-submit).
 *
 *  - نشست: `__Host-sid` با `HttpOnly; Secure; SameSite=Strict; Path=/`
 *    (پیشوند `__Host-` در production الزامی است تا SubDomain/Cookie-tossing ممکن نباشد)
 *  - CSRF: کوکی `csrf` (قابل خواندن توسط JS) + هدر `X-CSRF-Token` برای همهٔ
 *    متدهای غیر GET، به‌علاوهٔ بررسی `Origin`/`Referer`.
 */

export const CSRF_COOKIE_NAME = 'csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** نام کوکی نشست؛ در production حتماً `__Host-sid`. */
export function resolveSessionCookieName(env: AppEnv): string {
  if (env.NODE_ENV === 'production') return '__Host-sid';
  // در توسعه روی http، پیشوند __Host- توسط مرورگر رد می‌شود
  return env.SESSION_COOKIE_NAME.startsWith('__Host-') ? 'sid' : env.SESSION_COOKIE_NAME;
}

export function cookieSecure(env: AppEnv): boolean {
  return env.NODE_ENV === 'production' || env.PUBLIC_BASE_URL.startsWith('https://');
}

export function sessionCookieOptions(env: AppEnv, maxAgeSeconds: number): CookieSerializeOptions {
  const secure = cookieSecure(env);
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function csrfCookieOptions(env: AppEnv): CookieSerializeOptions {
  return {
    // باید توسط JS فرانت‌اند خوانده شود ⇒ HttpOnly نیست
    httpOnly: false,
    secure: cookieSecure(env),
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 12,
  };
}

/**
 * توکن CSRF امضاشده با `CSRF_SECRET`.
 * امضا باعث می‌شود حتی اگر مهاجم بتواند کوکی‌ای روی دامنه بنشاند،
 * نتواند توکن معتبر بسازد.
 */
export function issueCsrfToken(env: AppEnv, nonce: string): string {
  const mac = createHmac('sha256', env.CSRF_SECRET).update(nonce).digest('hex').slice(0, 32);
  return `${nonce}.${mac}`;
}

export function verifyCsrfToken(env: AppEnv, token: string): boolean {
  const parts = String(token ?? '').split('.');
  const nonce = parts[0] ?? '';
  const mac = parts[1] ?? '';
  if (!nonce || !mac) return false;
  const expected = createHmac('sha256', env.CSRF_SECRET).update(nonce).digest('hex').slice(0, 32);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * بررسی Same-Origin: چون فرانت و API هم‌دامنه هستند، هر درخواست تغییردهنده
 * باید Origin (یا Referer) هم‌دامنه با `PUBLIC_BASE_URL` داشته باشد.
 * درخواست‌های بدون Origin از کلاینت‌های هم‌دامنه (همان مرورگر، navigation) پذیرفته می‌شوند
 * زیرا SameSite=Strict ارسال کوکی را در درخواست cross-site متوقف می‌کند.
 */
export function isSameOrigin(env: AppEnv, headers: { origin?: string; referer?: string; host?: string }): boolean {
  const origin = headers.origin ?? '';
  const referer = headers.referer ?? '';
  const host = headers.host ?? '';
  const source = origin || referer;
  if (!source) return true; // بدون Origin ⇒ همان دامنه (کوکی با SameSite=Strict ارسال شده)

  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;
  }
  if (!sourceHost) return false;
  if (sourceHost === host) return true;

  if (env.PUBLIC_BASE_URL) {
    try {
      if (new URL(env.PUBLIC_BASE_URL).host === sourceHost) return true;
    } catch {
      /* مقدار نامعتبر ⇒ رد */
    }
  }

  // محیط توسعه: Vite dev server روی پورت متفاوت
  if (env.NODE_ENV !== 'production') {
    const hostName = host.split(':')[0] ?? '';
    const sourceName = sourceHost.split(':')[0] ?? '';
    if (hostName === sourceName) return true;
    if (['localhost', '127.0.0.1', '[::1]'].includes(sourceName) && ['localhost', '127.0.0.1', '[::1]'].includes(hostName)) return true;
  }
  return false;
}
