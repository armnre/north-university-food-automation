import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditQuerySchema, auditResponseSchema } from '@food/shared';
import { listAuditActions, listAuditLogs } from '../services/audit-query.service.js';
import type { ServiceDeps } from '../types.js';

/** مشاهدهٔ لاگ ممیزی (فقط SuperAdmin — مجوز `audit`). */
export function auditRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      {
        schema: {
          querystring: auditQuerySchema,
          response: { 200: auditResponseSchema },
          tags: ['audit'],
          summary: 'فهرست رویدادهای ممیزی با فیلتر',
        },
        preValidation: app.requirePermission('audit'),
      },
      async (request) => listAuditLogs(deps, request.query),
    );

    app.get(
      '/actions',
      {
        schema: {
          response: { 200: z.object({ actions: z.array(z.string()) }) },
          tags: ['audit'],
          summary: 'فهرست اقدام‌های ثبت‌شده (برای فیلتر)',
        },
        preValidation: app.requirePermission('audit'),
      },
      async () => ({ actions: await listAuditActions(deps) }),
    );
  };
}
