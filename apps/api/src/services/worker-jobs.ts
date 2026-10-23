import { hostname } from 'node:os';
import type pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { tehranParts, tehranToday } from '@food/shared';
import { jobRuns, notificationOutbox } from '../db/schema/index.js';
import type { ServiceDeps } from '../types.js';
import { markNoShows } from './reservation.service.js';
import { reconcilePendingPayments } from './payment.service.js';
import { deleteExpiredSessions } from './session.service.js';
import { purgeLoginAttempts } from './login-throttle.service.js';
import { deleteStaleCaptchas } from './captcha.service.js';
import { cleanupImportRows } from './import.service.js';
import { reconcileLedger } from './ledger.service.js';
import { alertFinanceAndAdmins } from './notification.service.js';
import { sendMealReminders } from './reminder.service.js';

/**
 * موتور زمان‌بندی و اجرای ایمن jobهای پس‌زمینه (`food-worker`).
 *
 * تضمین‌های عملیاتی:
 *  - هر job پیش از اجرا روی یک اتصال اختصاصی PostgreSQL قفل مشورتی غیرمسدودکننده
 *    (`pg_try_advisory_lock(LOCK_NAMESPACE, lockId)`) می‌گیرد و در `finally` روی
 *    **همان اتصال** آزاد می‌کند؛ بنابراین اجرای هم‌زمان دو نمونه از worker هیچ‌گاه
 *    باعث اجرای تکراری نمی‌شود.
 *  - هر اجرا در جدول `job_runs` با وضعیت `Running` → `Ok` / `Failed` / `Skipped` ثبت می‌شود.
 *  - زمان‌بندی کارهای روزانه بر مبنای ساعت رسمی تهران (`Asia/Tehran`) است.
 */

const LOCK_NAMESPACE = 20261023;

export type WorkerJobName =
  | 'mark-no-shows'
  | 'send-meal-reminders'
  | 'reconcile-payments'
  | 'cleanup-captchas'
  | 'cleanup-sessions'
  | 'purge-login-attempts'
  | 'cleanup-import-rows'
  | 'reconcile-ledger'
  | 'drain-sms-outbox';

export type JobExecutionSummary = {
  job: WorkerJobName;
  status: 'Ok' | 'Failed' | 'Skipped';
  durationMs: number;
  message: string;
  details?: Record<string, unknown>;
};

type JobSpec = {
  name: WorkerJobName;
  lockId: number;
  intervalMs: number;
  /** اگر تعیین شود، علاوه بر اجرای دوره‌ای، در ساعت مشخص تهران هم اجرا می‌شود. */
  dailyTehranHour?: number;
  dailyTehranMinute?: number;
  run: (deps: ServiceDeps) => Promise<{ message: string; details: Record<string, unknown> }>;
};

/** پردازش صف پیامک (در حالت پیش‌فرض `console` بدون ارسال بیرونی Skipped می‌شود). */
export async function drainSmsOutbox(deps: ServiceDeps): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
  const due = await deps.db
    .select()
    .from(notificationOutbox)
    .where(sql`${notificationOutbox.status} = 'Queued' AND ${notificationOutbox.nextAttemptAt} <= now()`)
    .limit(50);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due) {
    if (deps.env.SMS_PROVIDER !== 'kavenegar' || !deps.env.KAVENEGAR_API_KEY) {
      await deps.db
        .update(notificationOutbox)
        .set({ status: 'Skipped', lastError: 'sms_disabled_console_mode' })
        .where(eq(notificationOutbox.id, row.id));
      skipped += 1;
      continue;
    }

    try {
      const params = new URLSearchParams({
        receptor: row.recipient,
        message: row.message,
        ...(deps.env.KAVENEGAR_SENDER ? { sender: deps.env.KAVENEGAR_SENDER } : {}),
      });
      const response = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(deps.env.KAVENEGAR_API_KEY)}/sms/send.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`kavenegar_http_${response.status}`);
      await deps.db
        .update(notificationOutbox)
        .set({ status: 'Sent', sentAt: new Date(), attempts: row.attempts + 1, lastError: null })
        .where(eq(notificationOutbox.id, row.id));
      sent += 1;
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      const exhausted = nextAttempts >= deps.env.SMS_MAX_ATTEMPTS;
      const backoffMs = Math.min(3_600_000, 60_000 * 2 ** nextAttempts);
      await deps.db
        .update(notificationOutbox)
        .set({
          status: exhausted ? 'Failed' : 'Queued',
          attempts: nextAttempts,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          lastError: (err instanceof Error ? err.message : 'sms_error').slice(0, 200),
        })
        .where(eq(notificationOutbox.id, row.id));
      failed += 1;
    }
  }

  return { processed: due.length, sent, skipped, failed };
}

export const WORKER_JOBS: readonly JobSpec[] = [
  {
    name: 'mark-no-shows',
    lockId: 101,
    intervalMs: 5 * 60_000,
    async run(deps) {
      const marked = await markNoShows(deps);
      return { message: `${marked} رزرو به وضعیت عدم مراجعه تغییر یافت`, details: { marked } };
    },
  },
  {
    name: 'send-meal-reminders',
    lockId: 109,
    intervalMs: 10 * 60_000,
    async run(deps) {
      const res = await sendMealReminders(deps);
      return {
        message: `یادآوری وعده بررسی شد (ارسال درون‌برنامه‌ای: ${res.sent}، صف پیامک: ${res.smsQueued})`,
        details: res,
      };
    },
  },
  {
    name: 'reconcile-payments',
    lockId: 102,
    intervalMs: 15 * 60_000,
    async run(deps) {
      const res = await reconcilePendingPayments(deps, 30);
      return {
        message: `بررسی ${res.checked} پرداخت Pending (تسویه‌شده: ${res.settled}، منقضی: ${res.markedFailed}، ترمیم NeedsReview: ${res.needsReviewRetried})`,
        details: res,
      };
    },
  },
  {
    name: 'cleanup-captchas',
    lockId: 103,
    intervalMs: 30 * 60_000,
    async run(deps) {
      const deleted = await deleteStaleCaptchas(deps, 6);
      return { message: `${deleted} کپچای منقضی پاک شد`, details: { deleted } };
    },
  },
  {
    name: 'cleanup-sessions',
    lockId: 104,
    intervalMs: 60 * 60_000,
    async run(deps) {
      const deleted = await deleteExpiredSessions(deps, 7);
      return { message: `${deleted} نشست منقضی پاک شد`, details: { deleted } };
    },
  },
  {
    name: 'purge-login-attempts',
    lockId: 105,
    intervalMs: 24 * 3_600_000,
    dailyTehranHour: 3,
    dailyTehranMinute: 15,
    async run(deps) {
      const deleted = await purgeLoginAttempts(deps, 30);
      return { message: `${deleted} رکورد تلاش ورود قدیمی پاک شد`, details: { deleted } };
    },
  },
  {
    name: 'cleanup-import-rows',
    lockId: 106,
    intervalMs: 24 * 3_600_000,
    dailyTehranHour: 3,
    dailyTehranMinute: 30,
    async run(deps) {
      const deleted = await cleanupImportRows(deps, 7);
      return { message: `${deleted} ردیف پیش‌نمایش واردسازی قدیمی پاک شد`, details: { deleted } };
    },
  },
  {
    name: 'reconcile-ledger',
    lockId: 107,
    intervalMs: 6 * 3_600_000,
    dailyTehranHour: 4,
    dailyTehranMinute: 0,
    async run(deps) {
      const report = await reconcileLedger(deps.db);
      const issues = report.unbalancedTransactions.length + report.balanceMismatches.length;
      if (issues > 0) {
        deps.log.error({ report }, 'مغایرت در تطبیق دوره‌ای دفتر کل مشاهده شد');
        await alertFinanceAndAdmins(deps, {
          title: 'هشدار فوری: مغایرت در تطبیق دفتر کل',
          body: `تعداد تراکنش نامتوازن: ${report.unbalancedTransactions.length}، مغایرت موجودی حساب: ${report.balanceMismatches.length}.`,
          event: 'system.alert',
        });
      }
      return {
        message:
          issues === 0
            ? `تطبیق دفتر کل سالم (${report.checkedAccounts} حساب، ${report.checkedTransactions} تراکنش)`
            : `هشدار: ${issues} مغایرت در دفتر کل یافت شد`,
        details: {
          checkedAccounts: report.checkedAccounts,
          checkedTransactions: report.checkedTransactions,
          unbalancedCount: report.unbalancedTransactions.length,
          mismatchCount: report.balanceMismatches.length,
        },
      };
    },
  },
  {
    name: 'drain-sms-outbox',
    lockId: 108,
    intervalMs: 60_000,
    async run(deps) {
      const out = await drainSmsOutbox(deps);
      return {
        message: `صف پیامک بررسی شد (ارسال: ${out.sent}، ردشده: ${out.skipped}، خطا: ${out.failed})`,
        details: out,
      };
    },
  },
];

export function makeWorkerId(prefix = 'worker'): string {
  return `${prefix}-${hostname()}-${process.pid}`.slice(0, 80);
}

/**
 * اجرای یک job با قفل مشورتی روی یک اتصال اختصاصی PostgreSQL.
 */
export async function runLockedJob(
  pool: pg.Pool,
  deps: ServiceDeps,
  jobName: WorkerJobName,
  workerId = makeWorkerId(),
): Promise<JobExecutionSummary> {
  const spec = WORKER_JOBS.find((j) => j.name === jobName);
  if (!spec) throw new Error(`Unknown worker job: ${jobName}`);

  const startedAt = new Date();
  const t0 = Date.now();
  const lockClient = await pool.connect();
  let destroyConnection = false;

  try {
    const lockRes = await lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [
      LOCK_NAMESPACE,
      spec.lockId,
    ]);
    const locked = Boolean(lockRes.rows[0]?.locked);

    if (!locked) {
      const finishedAt = new Date();
      await deps.db.insert(jobRuns).values({
        job: spec.name,
        status: 'Skipped',
        startedAt,
        finishedAt,
        message: 'اجرا توسط نمونهٔ دیگر worker در جریان است (advisory lock)',
        details: { reason: 'advisory_lock_busy' },
        workerId,
      });
      deps.log.debug({ job: spec.name, workerId }, 'job رد شد؛ قفل در اختیار worker دیگر است');
      return {
        job: spec.name,
        status: 'Skipped',
        durationMs: Date.now() - t0,
        message: 'locked_by_another_worker',
      };
    }

    const [runRow] = await deps.db
      .insert(jobRuns)
      .values({
        job: spec.name,
        status: 'Running',
        startedAt,
        workerId,
      })
      .returning({ id: jobRuns.id });

    try {
      const outcome = await spec.run(deps);
      const finishedAt = new Date();
      const durationMs = Date.now() - t0;
      await deps.db
        .update(jobRuns)
        .set({
          status: 'Ok',
          finishedAt,
          message: outcome.message.slice(0, 500),
          details: outcome.details,
        })
        .where(eq(jobRuns.id, runRow!.id));

      deps.log.info({ job: spec.name, workerId, durationMs, ...outcome.details }, outcome.message);
      return {
        job: spec.name,
        status: 'Ok',
        durationMs,
        message: outcome.message,
        details: outcome.details,
      };
    } catch (error) {
      const finishedAt = new Date();
      const durationMs = Date.now() - t0;
      const errMessage = error instanceof Error ? error.message : String(error);
      await deps.db
        .update(jobRuns)
        .set({
          status: 'Failed',
          finishedAt,
          message: errMessage.slice(0, 500),
          details: { error: errMessage },
        })
        .where(eq(jobRuns.id, runRow!.id));

      deps.log.error({ err: error, job: spec.name, workerId, durationMs }, 'اجرای job زمان‌بندی‌شده ناموفق بود');
      return {
        job: spec.name,
        status: 'Failed',
        durationMs,
        message: errMessage,
      };
    } finally {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, spec.lockId]);
      } catch {
        destroyConnection = true;
      }
    }
  } finally {
    lockClient.release(destroyConnection);
  }
}

/** اجرای یک‌بارهٔ همهٔ jobها به ترتیب (مناسب شروع سرویس و تست یکپارچه). */
export async function runAllWorkerJobsOnce(pool: pg.Pool, deps: ServiceDeps, workerId = makeWorkerId()): Promise<JobExecutionSummary[]> {
  const summaries: JobExecutionSummary[] = [];
  for (const spec of WORKER_JOBS) {
    summaries.push(await runLockedJob(pool, deps, spec.name, workerId));
  }
  return summaries;
}

export type WorkerHandle = {
  stop: () => Promise<void>;
};

/** راه‌اندازی حلقهٔ زمان‌بندی مداوم بر پایهٔ بازه‌های زمانی و ساعت رسمی تهران (`Asia/Tehran`). */
export function startWorkerScheduler(pool: pg.Pool, deps: ServiceDeps, workerId = makeWorkerId()): WorkerHandle {
  let stopping = false;
  const inFlight = new Set<Promise<unknown>>();
  const timers: NodeJS.Timeout[] = [];
  const lastDailyRunDate = new Map<WorkerJobName, string>();

  const trigger = (jobName: WorkerJobName) => {
    if (stopping) return;
    const p = runLockedJob(pool, deps, jobName, workerId).catch((err) => {
      deps.log.error({ err, job: jobName, workerId }, 'خطای پیش‌بینی‌نشده در اجرای job');
    });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  // اجرای اولیهٔ jobهای کلیدی پس از بالا آمدن worker
  for (const job of [
    'mark-no-shows',
    'send-meal-reminders',
    'reconcile-payments',
    'cleanup-captchas',
    'cleanup-sessions',
    'reconcile-ledger',
  ] as const) {
    trigger(job);
  }

  for (const spec of WORKER_JOBS) {
    const timer = setInterval(() => trigger(spec.name), spec.intervalMs);
    timers.push(timer);
  }

  // بررسی دقیقه‌ای برای jobهای مقید به ساعت مشخص تهران (Asia/Tehran)
  const dailyTick = setInterval(() => {
    if (stopping) return;
    const now = new Date();
    const todayFa = tehranToday(now);
    const parts = tehranParts(now);
    for (const spec of WORKER_JOBS) {
      if (spec.dailyTehranHour == null || spec.dailyTehranMinute == null) continue;
      if (parts.hour === spec.dailyTehranHour && parts.minute === spec.dailyTehranMinute) {
        if (lastDailyRunDate.get(spec.name) !== todayFa) {
          lastDailyRunDate.set(spec.name, todayFa);
          trigger(spec.name);
        }
      }
    }
  }, 30_000);
  timers.push(dailyTick);

  return {
    async stop() {
      stopping = true;
      for (const timer of timers) clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
}
