import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { adminNotifyRequestSchema, adminNotificationsResponseSchema } from '@food/shared';
import { listAdminNotifications, sendAdminNotification } from '../services/notification-admin.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/** اعلان‌های مدیریتی: ارسال (عمومی/یک حساب/کارکنان) و فهرست اعلان‌های ارسال‌شده. */
export function notificationRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preValidation', app.requirePermission('notify'));

    app.get(
      '/admin',
      { schema: { response: { 200: adminNotificationsResponseSchema }, tags: ['notifications'], summary: 'فهرست اعلان‌های ارسال‌شده' } },
      async () => listAdminNotifications(deps, 50),
    );

    app.post(
      '/admin',
      {
        schema: {
          body: adminNotifyRequestSchema,
          response: { 200: z.object({ id: z.string(), recipients: z.number().int() }) },
          tags: ['notifications'],
          summary: 'ارسال اعلان به همهٔ کاربران یا یک حساب مشخص',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 20), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        return sendAdminNotification(deps, {
          title: request.body.title,
          body: request.body.body,
          audience: request.body.audience,
          identifier: request.body.identifier,
          staffUserId: request.body.staffUserId,
          sendSms: request.body.sendSms,
          actor: actorOf(auth),
          staffId: auth.staffId,
          ip: request.clientIp,
        });
      },
    );
  };
}
