import { auditLogs } from '../db/schema/index.js';
import type { Actor, ServiceDeps, Tx } from '../types.js';

/**
 * ممیزی: هر عملیات مالی و مدیریتی ثبت می‌شود (append-only).
 *
 * هیچ دادهٔ حساسی (کد ملی خام، رمز، شبا، توکن) در `details` نوشته نمی‌شود؛
 * تابع `sanitizeDetails` کلیدهای ممنوعه را جایگزین `[REDACTED]` می‌کند.
 */

const FORBIDDEN_DETAIL_KEYS = [
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'nationalid',
  'iban',
  'token',
  'qrtoken',
  'setupcode',
  'csrf',
  'cookie',
  'secret',
  'pepper',
  'apikey',
  'merchantid',
];

export function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_DETAIL_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

export type AuditInput = {
  actor: Actor;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

/** ثبت رویداد ممیزی. داخل تراکنش اصلی فراخوانی شود تا با خود عملیات atomic باشد. */
export async function writeAudit(target: Tx | ServiceDeps['db'], input: AuditInput): Promise<void> {
  await target.insert(auditLogs).values({
    actorType: input.actor.type,
    actorId: input.actor.id || null,
    actorLabel: String(input.actor.label ?? '').slice(0, 160),
    action: input.action,
    targetType: input.targetType,
    targetId: String(input.targetId ?? '').slice(0, 64),
    details: sanitizeDetails(input.details),
    ip: String(input.ip ?? '').slice(0, 64),
    userAgent: input.userAgent ? String(input.userAgent).slice(0, 300) : null,
  });
}
