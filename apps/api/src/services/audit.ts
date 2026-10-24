import type { Db, Tx } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

export type AuditInput = {
  actor: string;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  ip?: string;
  requestId?: string;
};

/** Never pass raw national ids or secrets in `data`. */
export async function audit(db: Db | Tx, a: AuditInput) {
  await db.insert(auditLogs).values({ ...a, data: a.data ?? null });
}
