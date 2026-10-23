import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { healthResponseSchema, readyResponseSchema } from '@food/shared';
import { jobRuns } from '../db/schema/index.js';
import { appliedMigrationCount, listMigrations } from '../db/migrate.js';
import type { ServiceDeps } from '../types.js';

/**
 * پایش:
 *  - `/api/health` : زنده بودن پروسه (بدون بررسی دیتابیس) — برای systemd و لودبالانسر
 *  - `/api/ready`  : آمادگی سرویس (اتصال دیتابیس + وضعیت مهاجرت‌ها + آخرین اجرای worker)
 */
export function healthRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  const startedAt = Date.now();

  const routes: FastifyPluginAsyncZod = async (app) => {
    app.get(
      '/health',
      {
        schema: { response: { 200: healthResponseSchema }, summary: 'بررسی زنده بودن سرویس' },
        config: { rateLimit: false },
      },
      async () => ({
        status: 'ok' as const,
        version: process.env.APP_VERSION ?? '1.0.0',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      }),
    );

    app.get(
      '/ready',
      {
        schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema }, summary: 'بررسی آمادگی سرویس' },
        config: { rateLimit: false },
      },
      async (_request, reply) => {
        let databaseUp: boolean;
        try {
          await deps.db.execute(sql`SELECT 1`);
          databaseUp = true;
        } catch {
          databaseUp = false;
        }

        const available = listMigrations().length;
        let applied = 0;
        if (databaseUp) {
          try {
            applied = await appliedMigrationCount(deps.env.DATABASE_URL);
          } catch {
            applied = 0;
          }
        }

        let worker: { lastRunAt: string | null } | null = null;
        if (databaseUp) {
          const rows = await deps.db
            .select({ finishedAt: jobRuns.finishedAt, startedAt: jobRuns.startedAt })
            .from(jobRuns)
            .orderBy(sql`${jobRuns.startedAt} DESC`)
            .limit(1);
          const last = rows[0];
          worker = { lastRunAt: (last?.finishedAt ?? last?.startedAt ?? null)?.toISOString() ?? null };
        }

        const payload = {
          status: (databaseUp && applied >= available ? 'ready' : 'not-ready') as 'ready' | 'not-ready',
          database: (databaseUp ? 'up' : 'down') as 'up' | 'down',
          migrations: { applied, available },
          worker,
        };
        return reply.status(payload.status === 'ready' ? 200 : 503).send(payload);
      },
    );
  };

  return routes;
}
