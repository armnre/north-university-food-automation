import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminCancelReservationRequestSchema,
  adminReservationsQuerySchema,
  adminReservationsResponseSchema,
  cancelReservationResponseSchema,
} from '@food/shared';
import { computeCancelDeadline } from '../services/reservation.service.js';
import { adminCancelReservation } from '../services/reservation.service.js';
import { getSettings } from '../services/settings.service.js';
import { queryReservations } from '../repositories/reservation.repo.js';
import { actorOf, type ServiceDeps } from '../types.js';

/** مدیریت رزروها (مشاهده برای معاونت/مدیر تغذیه، لغو اداری با مجوز `reservationCancel`). */
export function reservationRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      {
        schema: {
          querystring: adminReservationsQuerySchema,
          response: { 200: adminReservationsResponseSchema },
          tags: ['reservations'],
          summary: 'فهرست رزروها با فیلتر',
        },
        preValidation: app.requirePermission(['reservations', 'finance', 'students']),
      },
      async (request) => {
        const settings = await getSettings(deps);
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        const { rows, total } = await queryReservations(deps.db, {
          from: request.query.from,
          to: request.query.to,
          cafeteriaId: request.query.cafeteriaId,
          offeringId: request.query.offeringId,
          status: request.query.status,
          customerGroup: request.query.customerGroup,
          search: request.query.search,
          offset: request.query.offset,
          limit: request.query.limit,
          // اپراتور فقط سلف خودش
          ...(auth.role === 'Operator' && auth.cafeteriaId ? { cafeteriaId: auth.cafeteriaId } : {}),
        });
        const now = new Date();
        return {
          reservations: rows.map((row) => {
            const deadline = computeCancelDeadline(
              { offeringCancelDeadline: row.offeringCancelDeadline, serviceDate: row.serviceDate, slotStartTime: row.slotStartTime },
              settings,
            );
            return {
              id: row.id,
              code: row.code,
              status: row.status,
              priceRial: row.priceRial,
              createdAt: row.createdAt.toISOString(),
              offeringId: row.offeringId,
              serviceDate: row.serviceDate,
              mealSlot: row.mealSlot,
              foodName: row.foodName,
              cafeteriaId: row.cafeteriaId,
              cafeteriaName: row.cafeteriaName,
              cancelDeadline: deadline.toISOString(),
              accountId: row.accountId,
              customerGroup: row.customerGroup,
              holderName: row.holderName,
              holderIdentifier: row.holderIdentifier,
              deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
              canCancel: row.status === 'Reserved' && deadline.getTime() > now.getTime(),
            };
          }),
          total,
          hasMore: rows.length === request.query.limit,
        };
      },
    );

    app.post(
      '/:id/cancel',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: adminCancelReservationRequestSchema,
          response: { 200: cancelReservationResponseSchema },
          tags: ['reservations'],
          summary: 'لغو اداری رزرو با دلیل و بازپرداخت کامل',
        },
        preValidation: app.requirePermission('reservationCancel'),
      },
      async (request) => {
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        return adminCancelReservation(deps, {
          actor: actorOf(auth),
          reservationId: (request.params as { id: string }).id,
          reason: request.body.reason,
          ip: request.clientIp,
          staffId: auth.staffId,
        });
      },
    );
  };
}
