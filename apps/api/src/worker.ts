import pino from 'pino';
import { loadEnv } from './env.js';
import { createDb, createPool } from './db/client.js';
import { gatewayFromEnv } from './services/gateway.js';
import { runJob, tehranNow, type JobFn } from './jobs/runner.js';
import { cleanup, drainSmsOutbox, markNoShow, reconcileLedger, reconcilePendingPayments, sendMealReminders } from './jobs/jobs.js';
import { smsFromEnv } from './services/sms.js';

const env = loadEnv();
const log = pino({ name: 'food-worker', level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
const pool = createPool(env.DATABASE_URL, Math.min(env.DATABASE_POOL_MAX, 3));
const db = createDb(pool);
const gw = gatewayFromEnv(env);
const sendSms = smsFromEnv(env, log);

type Schedule = { job: string; fn: JobFn; everyMin?: number; dailyAt?: { hour: number; minute: number } };
const schedules: Schedule[] = [
  { job: 'reconcile-pending-payments', everyMin: 10, fn: (d) => reconcilePendingPayments(d, gw) },
  { job: 'mark-no-show', everyMin: 15, fn: (d) => markNoShow(d) },
  { job: 'send-meal-reminders', everyMin: 5, fn: sendMealReminders },
  { job: 'drain-sms-outbox', everyMin: 1, fn: (d) => drainSmsOutbox(d, sendSms) },
  { job: 'reconcile-ledger', dailyAt: { hour: 3, minute: 30 }, fn: reconcileLedger },
  { job: 'cleanup', dailyAt: { hour: 4, minute: 0 }, fn: cleanup },
];

let stopping = false;
const running = new Set<Promise<unknown>>();
const lastDaily = new Map<string, string>();

function due(s: Schedule, now: Date) {
  const t = tehranNow(now);
  if (s.everyMin) return (t.hour * 60 + t.minute) % s.everyMin === 0;
  if (s.dailyAt && t.hour === s.dailyAt.hour && t.minute === s.dailyAt.minute && lastDaily.get(s.job) !== t.date) {
    lastDaily.set(s.job, t.date);
    return true;
  }
  return false;
}

async function tick() {
  if (stopping) return;
  for (const s of schedules) {
    if (!due(s, new Date())) continue;
    const p = runJob(db, pool, s.job, s.fn, log).finally(() => running.delete(p));
    running.add(p);
  }
}

log.info({ jobs: schedules.map((s) => s.job), online: !!gw }, 'worker started');
// Align to minute boundaries (Asia/Tehran wall clock).
setTimeout(
  () => {
    void tick();
    setInterval(() => void tick(), 60_000).unref();
  },
  60_000 - (Date.now() % 60_000),
);
setInterval(() => {}, 1 << 30); // keep process alive

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    stopping = true;
    log.info({ sig, inflight: running.size }, 'worker stopping');
    await Promise.allSettled([...running]);
    await pool.end();
    process.exit(0);
  });
}
