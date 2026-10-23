import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  offeringBulkRequestSchema,
  offeringBulkResponseSchema,
  offeringStatusChangeRequestSchema,
  offeringStatusChangeResponseSchema,
  offeringsQuerySchema,
  offeringsResponseSchema,
  offeringUpsertRequestSchema,
} from '@food/shared';
import { AppError } from '../lib/errors.js';
import { offeringStatusNeedsReason } from '@food/shared';
import type { ServiceDeps } from '../types.js';
import { actorOf } from '../types.js';
import { bulkCreateOfferings, getOffering, listOfferings, saveOffering } from '../services/offering.service.js';
import { closeOfferingWithRefunds } from '../services/reservation.service.js';
import { mapOfferingToDto } from './mappers.js';

/** منو، قیمت‌گذاری و وضعیت وعده‌ها. */
export function offeringRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      {
        schema: {
          querystring: offeringsQuerySchema,
          response: { 200: offeringsResponseSchema },
          tags: ['offerings'],
          summary: 'فهرست وعده‌ها با شمارنده‌های زنده',
        },
        preValidation: app.requirePermission([
          'offerings',
          'delivery',
          'reports',
          'reservations',
          'contractorReports',
          'students',
          'finance',
        ]),
      },
      async (request) => {
        const query = request.query;
        const auth = request.auth!;
        const rows = await listOfferings(deps, {
          from: query.from,
          to: query.to,
          cafeteriaId: query.cafeteriaId,
          mealSlot: query.mealSlot,
          status: query.status,
          foodId: query.foodId,
          // اپراتور فقط سلف خودش
          cafeteriaIds: auth.kind === 'staff' && auth.role === 'Operator' && auth.cafeteriaId ? [auth.cafeteriaId] : undefined,
        });
        return { offerings: rows.map((row) => mapOfferingToDto(row)) };
      },
    );

    app.post(
      '/',
      {
        schema: {
          body: offeringUpsertRequestSchema,
          response: { 200: z.object({ id: z.uuid() }) },
          tags: ['offerings'],
          summary: 'ساخت آیتم منو با قیمت هر گروه',
        },
        preValidation: app.requirePermission('offerings'),
      },
      async (request) => {
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        return saveOffering(deps, { ...request.body, actor: actorOf(auth), staffId: auth.staffId, ip: request.clientIp });
      },
    );

    app.put(
      '/:id',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: offeringUpsertRequestSchema,
          response: { 200: z.object({ id: z.uuid() }) },
          tags: ['offerings'],
          summary: 'ویرایش آیتم منو (تغییر قیمت پس از انتشار با دلیل و ممیزی)',
        },
        preValidation: app.requirePermission('offerings'),
      },
      async (request) => {
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        const { id } = request.params as { id: string };
        return saveOffering(deps, { ...request.body, id, actor: actorOf(auth), staffId: auth.staffId, ip: request.clientIp });
      },
    );

    app.post(
      '/bulk',
      {
        schema: {
          body: offeringBulkRequestSchema,
          response: { 200: offeringBulkResponseSchema },
          tags: ['offerings'],
          summary: 'ساخت دسته‌ای منو یا کپی یک بازه',
        },
        preValidation: app.requirePermission('offerings'),
      },
      async (request) => {
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        return bulkCreateOfferings(deps, { ...request.body, actor: actorOf(auth), staffId: auth.staffId, ip: request.clientIp });
      },
    );

    /** «تمام شد» (SoldOut) و «لغو وعده» (Cancelled) با بازپرداخت خودکار. */
    app.patch(
      '/:id/status',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: offeringStatusChangeRequestSchema,
          response: { 200: offeringStatusChangeResponseSchema },
          tags: ['offerings'],
          summary: 'تغییر وضعیت وعده (تمام شد / لغو وعده) با بازپرداخت خودکار',
        },
        preValidation: app.requirePermission('offerings'),
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '5 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        const { id } = request.params as { id: string };
        const { status, reason, confirmText } = request.body;

        if (offeringStatusNeedsReason(status) && reason.trim().length < 5) {
          throw new AppError('VALIDATION', 'برای «تمام شد» یا «لغو وعده» ذکر دلیل (حداقل ۵ کاراکتر) الزامی است.');
        }
        // تأیید با تایپ برای عملیات مخرب
        if (status === 'Cancelled' || status === 'SoldOut') {
          const offering = await getOffering(deps, id);
          const expected = status === 'Cancelled' ? 'لغو وعده' : 'تمام شد';
          if (offering.reservedCount > 0 && confirmText !== expected) {
            throw new AppError('VALIDATION', `برای تأیید، عبارت «${expected}» را تایپ کنید.`, { expected });
          }
        }

        if (status === 'SoldOut' || status === 'Cancelled') {
          return closeOfferingWithRefunds(deps, {
            offeringId: id,
            status,
            reason: reason.trim(),
            actor: actorOf(auth),
            ip: request.clientIp,
            staffId: auth.staffId,
          });
        }

        // بازگرداندن وعده به وضعیت Published/Closed بدون رزرو
        const offering = await getOffering(deps, id);
        return saveOffering(deps, {
          id,
          serviceDate: offering.serviceDate,
          mealSlot: offering.mealSlot,
          foodId: offering.foodId,
          cafeteriaId: offering.cafeteriaId,
          capacity: offering.capacity,
          reserveOpensAt: offering.reserveOpensAt.toISOString(),
          reserveDeadline: offering.reserveDeadline.toISOString(),
          cancelDeadline: offering.cancelDeadline ? offering.cancelDeadline.toISOString() : null,
          status,
          notes: offering.notes,
          prices: Object.fromEntries(offering.prices.map((p) => [p.customerGroup, p.priceRial])),
          reason: reason.trim(),
          actor: actorOf(auth),
          staffId: auth.staffId,
          ip: request.clientIp,
        }).then(async (result) => ({ id: result.id, status, cancelledReservations: 0, refundedRial: 0, notified: 0, failed: 0 }));
      },
    );
  };
}
