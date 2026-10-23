import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { settingsResponseSchema, settingsUpdateRequestSchema, SETTINGS_META } from '@food/shared';
import { mealSlots } from '../db/schema/index.js';
import { AppError, fail } from '../lib/errors.js';
import { SettingsValidationError, getSettings, loadSettingsRaw, updateSettings } from '../services/settings.service.js';
import { updateMealSlots } from '../services/catalog.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';
import { rawSql } from '../db/raw.js';

/** تنظیمات سامانه + ساعت وعده‌ها + وضعیت jobها (فقط SuperAdmin). */
export function settingsRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preValidation', app.requirePermission('settings'));

    app.get(
      '/',
      { schema: { response: { 200: settingsResponseSchema }, tags: ['settings'], summary: 'خواندن تنظیمات، وعده‌ها و آخرین اجرای jobها' } },
      async () => {
        const raw = await loadSettingsRaw(deps.db);
        const values = await getSettings(deps, { fresh: true });
        const slots = await deps.db.select().from(mealSlots).orderBy(mealSlots.sortOrder);
        const runs = await deps.db.execute(
          rawSql(
            `SELECT DISTINCT ON (job) job, status, started_at AS "startedAt", finished_at AS "finishedAt", message
           FROM job_runs ORDER BY job, started_at DESC LIMIT 20`,
          ),
        );
        const runRows = (((runs as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
          job: String(row.job ?? ''),
          status: String(row.status ?? ''),
          startedAt: new Date(String(row.startedAt)).toISOString(),
          finishedAt: row.finishedAt ? new Date(String(row.finishedAt)).toISOString() : null,
          message: row.message == null ? null : String(row.message),
        }));

        return {
          values: Object.fromEntries(Object.keys(SETTINGS_META).map((key) => [key, raw[key as keyof typeof raw] ?? ''])),
          meta: Object.values(SETTINGS_META).map((meta) => ({
            key: meta.key,
            kind: meta.kind,
            labelFa: meta.labelFa,
            descriptionFa: meta.descriptionFa,
            min: meta.min ?? null,
            max: meta.max ?? null,
            unit: meta.unit ?? null,
            defaultValue: meta.defaultValue,
          })),
          mealSlots: slots.map((slot) => ({
            id: slot.id,
            code: slot.code,
            title: slot.title,
            startTime: String(slot.startTime),
            endTime: String(slot.endTime),
            isActive: slot.isActive,
          })),
          jobRuns: runRows,
          payment: {
            enabled: values.onlinePaymentEnabled,
            merchantConfigured: Boolean(deps.env.ZARINPAL_MERCHANT_ID),
            gateway: deps.env.ZARINPAL_MERCHANT_ID ? 'zarinpal' : deps.env.ALLOW_SANDBOX_GATEWAY ? 'sandbox' : 'none',
          },
        };
      },
    );

    app.put(
      '/',
      {
        schema: {
          body: settingsUpdateRequestSchema,
          response: { 200: settingsResponseSchema },
          tags: ['settings'],
          summary: 'ویرایش تنظیمات و ساعت وعده‌ها با ممیزی قبل/بعد',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '5 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        try {
          if (request.body.values) {
            await updateSettings(deps, {
              values: request.body.values,
              actor: actorOf(auth),
              ip: request.clientIp,
              userAgent: request.headers['user-agent'],
            });
          }
          if (request.body.mealSlots?.length) {
            await updateMealSlots(deps, { slots: request.body.mealSlots, actor: actorOf(auth), ip: request.clientIp });
          }
        } catch (error) {
          if (error instanceof SettingsValidationError) throw new AppError('SETTINGS_INVALID', error.message);
          throw error;
        }
        if (!request.body.values && !request.body.mealSlots?.length) fail('VALIDATION', 'هیچ تغییری برای ذخیره ارسال نشد.');

        const raw = await loadSettingsRaw(deps.db);
        const values = await getSettings(deps, { fresh: true });
        const slots = await deps.db.select().from(mealSlots).orderBy(mealSlots.sortOrder);
        return {
          values: Object.fromEntries(Object.keys(SETTINGS_META).map((key) => [key, raw[key as keyof typeof raw] ?? ''])),
          meta: Object.values(SETTINGS_META).map((meta) => ({
            key: meta.key,
            kind: meta.kind,
            labelFa: meta.labelFa,
            descriptionFa: meta.descriptionFa,
            min: meta.min ?? null,
            max: meta.max ?? null,
            unit: meta.unit ?? null,
            defaultValue: meta.defaultValue,
          })),
          mealSlots: slots.map((slot) => ({
            id: slot.id,
            code: slot.code,
            title: slot.title,
            startTime: String(slot.startTime),
            endTime: String(slot.endTime),
            isActive: slot.isActive,
          })),
          jobRuns: [],
          payment: {
            enabled: values.onlinePaymentEnabled,
            merchantConfigured: Boolean(deps.env.ZARINPAL_MERCHANT_ID),
            gateway: deps.env.ZARINPAL_MERCHANT_ID ? 'zarinpal' : deps.env.ALLOW_SANDBOX_GATEWAY ? 'sandbox' : 'none',
          },
        };
      },
    );
  };
}
