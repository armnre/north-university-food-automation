import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { resetPasswordRequestSchema, resetPasswordResponseSchema, staffListResponseSchema, staffUpsertRequestSchema } from '@food/shared';
import { listStaff, resetStaffPassword, saveStaff } from '../services/staff.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/** مدیریت کارکنان سامانه با سلسله‌مراتب سخت‌گیرانه (بدون ساخت حساب هم‌سطح/بالاتر). */
export function staffRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      { schema: { response: { 200: staffListResponseSchema }, tags: ['staff'], summary: 'فهرست کارکنان قابل مدیریت' } },
      async (request) => listStaff(deps, request.auth as Extract<AuthContext, { kind: 'staff' }>),
    );

    app.post(
      '/',
      {
        schema: {
          body: staffUpsertRequestSchema,
          response: { 200: z.object({ id: z.uuid() }) },
          tags: ['staff'],
          summary: 'ساخت حساب کارکنان',
        },
        preValidation: app.requirePermission(['users', 'operators']),
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        if (request.body.id) throw new AppError('VALIDATION', 'برای ساخت حساب جدید، شناسه ارسال نکنید.');
        return saveStaff(deps, { data: request.body, me: auth, actor: actorOf(auth), ip: request.clientIp });
      },
    );

    app.put(
      '/:id',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: staffUpsertRequestSchema,
          response: { 200: z.object({ id: z.uuid() }) },
          tags: ['staff'],
          summary: 'ویرایش حساب کارکنان',
        },
        preValidation: app.requirePermission(['users', 'operators']),
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const { id } = request.params as { id: string };
        return saveStaff(deps, { data: { ...request.body, id }, me: auth, actor: actorOf(auth), ip: request.clientIp });
      },
    );

    app.post(
      '/:id/reset-password',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: resetPasswordRequestSchema,
          response: { 200: resetPasswordResponseSchema },
          tags: ['staff'],
          summary: 'ریست رمز عبور + ابطال نشست‌ها',
        },
        preValidation: app.requirePermission(['users', 'operators']),
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 20), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const result = await resetStaffPassword(deps, {
          id: (request.params as { id: string }).id,
          newPassword: request.body.newPassword,
          mustChangePassword: request.body.mustChangePassword,
          me: auth,
          actor: actorOf(auth),
          ip: request.clientIp,
        });
        return { ok: true as const, temporaryPassword: result.temporaryPassword, sessionsRevoked: result.sessionsRevoked };
      },
    );
  };
}
