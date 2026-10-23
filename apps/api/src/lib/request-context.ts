import type { FastifyRequest } from 'fastify';
import type { SubjectType } from '@food/shared';

/**
 * خواندن IP کلاینت با احترام به `TRUSTED_PROXY_HOPS`.
 *
 * در شبکهٔ دانشگاه چند لایه پروکسی ممکن است وجود داشته باشد و مقدار اول
 * `X-Forwarded-For` توسط کلاینت قابل جعل است. بنابراین از **انتهای** زنجیره
 * به تعداد N پرش قابل‌اعتماد خوانده می‌شود (N = تعداد پروکسی‌های خودمان).
 */
export function getClientIp(request: Pick<FastifyRequest, 'ip' | 'headers'>, trustedHops: number): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
  const chain = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (chain.length === 0 || trustedHops <= 0) return normalizeIp(request.ip);

  // chain = [client, proxy1, proxy2, ...] ؛ آخرین N ورودی توسط پروکسی‌های ما اضافه شده‌اند.
  const index = chain.length - trustedHops;
  const candidate = chain[Math.max(0, index)] ?? chain[0] ?? '';
  return normalizeIp(candidate) || normalizeIp(request.ip);
}

function normalizeIp(value: string | undefined): string {
  const ip = String(value ?? '').trim();
  if (!ip) return '';
  // نگاشت IPv4-in-IPv6
  const mapped = ip.replace(/^::ffff:/i, '');
  return mapped.slice(0, 64);
}

/** برچسب سوژهٔ احراز‌هویت‌شده برای لاگ (بدون دادهٔ حساس). */
export function subjectLabel(subjectType: SubjectType, subjectId: string): string {
  return `${subjectType.toLowerCase()}:${subjectId.slice(0, 8)}`;
}

/** خلاصهٔ User-Agent برای ذخیره در نشست (حداکثر ۴۰۰ کاراکتر). */
export function userAgentSummary(request: FastifyRequest): string {
  return String(request.headers['user-agent'] ?? '').slice(0, 400);
}

/** آیا مرورگر/کلاینت یک دستگاه جدید است؟ (مقایسهٔ ساده بر پایهٔ UA) */
export function isLikelyNewDevice(previousUserAgents: string[], current: string): boolean {
  if (!current) return false;
  if (previousUserAgents.length === 0) return true;
  const key = normalizeUa(current);
  return !previousUserAgents.some((ua) => normalizeUa(ua) === key);
}

function normalizeUa(ua: string): string {
  // حذف شمارهٔ نسخه‌ها تا تغییر جزئی مرورگر «دستگاه جدید» محسوب نشود
  return String(ua)
    .toLowerCase()
    .replace(/[\d.]+/g, '#')
    .slice(0, 120);
}
