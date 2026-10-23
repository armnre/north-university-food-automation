import { auditLogs } from '../db/schema/index.js';
import type { ServiceDeps } from '../types.js';
import { rawSql } from '../db/raw.js';

/** پرس‌وجوی لاگ ممیزی با فیلتر (فقط مشاهده؛ جدول append-only است). */
export type AuditQueryFilters = {
  search?: string;
  action?: string;
  actorType?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
};

export async function listAuditLogs(deps: ServiceDeps, filters: AuditQueryFilters) {
  const params: unknown[] = [];
  const where: string[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    where.push(`(action ILIKE ${p(like)} OR actor_label ILIKE ${p(like)} OR target_type ILIKE ${p(like)} OR target_id ILIKE ${p(like)})`);
  }
  if (filters.action) where.push(`action = ${p(filters.action)}`);
  if (filters.actorType) where.push(`actor_type = ${p(filters.actorType)}`);
  if (filters.actorId) where.push(`actor_id = ${p(filters.actorId)}::uuid`);
  if (filters.targetType) where.push(`target_type = ${p(filters.targetType)}`);
  if (filters.targetId) where.push(`target_id = ${p(filters.targetId)}`);
  if (filters.from) where.push(`(created_at AT TIME ZONE 'Asia/Tehran')::date >= ${p(filters.from)}::date`);
  if (filters.to) where.push(`(created_at AT TIME ZONE 'Asia/Tehran')::date <= ${p(filters.to)}::date`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const rowsResult = await deps.db.execute(
    rawSql(
      `SELECT id, action, actor_type AS "actorType", actor_label AS "actorLabel", target_type AS "targetType",
              target_id AS "targetId", details, ip, created_at AS "createdAt"
       FROM audit_logs ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
  );
  const countResult = await deps.db.execute(rawSql(`SELECT COUNT(*)::int AS n FROM audit_logs ${whereSql}`, params));

  const rows = ((rowsResult as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  return {
    logs: rows.map((row) => ({
      id: String(row.id),
      action: String(row.action ?? ''),
      actorType: String(row.actorType ?? ''),
      actorLabel: String(row.actorLabel ?? ''),
      targetType: String(row.targetType ?? ''),
      targetId: String(row.targetId ?? ''),
      details: (row.details as Record<string, unknown> | null) ?? null,
      ip: String(row.ip ?? ''),
      createdAt: new Date(String(row.createdAt)).toISOString(),
    })),
    total: Number(((countResult as unknown as { rows: { n: number }[] }).rows ?? [])[0]?.n ?? rows.length),
    hasMore: rows.length === limit,
  };
}

/** فهرست اقدام‌های ثبت‌شده (برای فیلتر در UI). */
export async function listAuditActions(deps: ServiceDeps): Promise<string[]> {
  const rows = await deps.db.execute(rawSql(`SELECT DISTINCT action FROM audit_logs ORDER BY action LIMIT 300`));
  return (((rows as unknown as { rows: { action: string }[] }).rows ?? []) as { action: string }[]).map((r) => r.action);
}

export const auditTable = auditLogs;
