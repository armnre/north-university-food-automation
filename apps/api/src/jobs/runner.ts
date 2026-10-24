import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export type JobLogger = { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
export type JobFn = (db: Db) => Promise<Record<string, unknown>>;

/** Stable 31-bit key per job name for pg_try_advisory_lock. */
export function lockKey(job: string): number {
  let h = 2166136261;
  for (const ch of job) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h & 0x7fffffff;
}

/**
 * Runs a job at most once cluster-wide (session advisory lock on a dedicated connection).
 * Every run that actually executes is recorded in job_runs. Returns null when another worker holds the lock.
 */
export async function runJob(db: Db, pool: import('pg').Pool, job: string, fn: JobFn, log: JobLogger) {
  const client = await pool.connect();
  try {
    const got = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(42, $1) AS ok', [lockKey(job)])).rows[0]!.ok;
    if (!got) return null;
    const run = (await db.execute<{ id: string }>(sql`INSERT INTO job_runs (job) VALUES (${job}) RETURNING id`)).rows[0]!;
    const t0 = Date.now();
    try {
      const detail = await fn(db);
      await db.execute(
        sql`UPDATE job_runs SET finished_at=now(), ok=true, detail=${JSON.stringify({ ...detail, ms: Date.now() - t0 })}::jsonb WHERE id=${run.id}`,
      );
      log.info({ job, ms: Date.now() - t0, ...detail }, 'job ok');
      return { ok: true, detail };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await db.execute(sql`UPDATE job_runs SET finished_at=now(), ok=false, detail=${JSON.stringify({ error: msg })}::jsonb WHERE id=${run.id}`);
      log.error({ job, err: msg }, 'job failed');
      return { ok: false, detail: { error: msg } };
    } finally {
      await client.query('SELECT pg_advisory_unlock(42, $1)', [lockKey(job)]);
    }
  } finally {
    client.release();
  }
}

/** Wall-clock parts in Asia/Tehran (no DST since 2022, but computed via Intl to stay correct). */
export function tehranNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
