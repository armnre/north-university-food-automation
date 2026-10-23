import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  checkoutRequestSchema,
  checkoutResponseSchema,
  createReservationRequestSchema,
  createReservationResponseSchema,
  markNotificationsReadRequestSchema,
  meMenuQuerySchema,
  meMenuResponseSchema,
  meNotificationsResponseSchema,
  myReservationsResponseSchema,
  okResponseSchema,
  reissueQrResponseSchema,
  tehranToday,
  walletResponseSchema,
} from '@food/shared';
import { mealSlotLabel } from '@food/shared';
import type { CustomerAuth, ServiceDeps } from '../types.js';
import { queryOfferings } from '../repositories/offering.repo.js';
import { queryReservations } from '../repositories/reservation.repo.js';
import {
  checkoutCart,
  computeCancelDeadline,
  isLiveStatus,
  listMyReservations,
  reissueQrToken,
  reserveMeal,
} from '../services/reservation.service.js';
import { getSettings } from '../services/settings.service.js';
import { myWallet } from '../services/finance.service.js';
import { listNotificationsForAccount, markNotificationsRead, unreadCountFor } from '../services/notification.service.js';

/** امور دانشجو/کارمند: منو، رزرو، سبد خرید، QR، اعتبار داخلی کیف پول و اعلان‌ها. */
export function meRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preValidation', app.requireCustomer);

    app.get(
      '/menu',
      {
        schema: {
          querystring: meMenuQuerySchema,
          response: { 200: meMenuResponseSchema },
          tags: ['me'],
          summary: 'منوی قابل رزرو با قیمت گروه مشتری جاری',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 120), timeWindow: '1 minute' } },
      },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        const settings = await getSettings(deps);
        const today = tehranToday();
        const from = request.query.from < today ? today : request.query.from;

        const offerings = await queryOfferings(deps.db, { from, to: request.query.to, onlyBookable: true });
        const mine = await queryReservations(deps.db, {
          accountId: auth.accountId,
          from: request.query.from,
          to: request.query.to,
          limit: 500,
        });
        const now = Date.now();

        const result = [];
        for (const offering of offerings) {
          const price = offering.prices.find((p) => p.customerGroup === auth.customerGroup);
          // نبود ردیف قیمت برای این گروه ⇒ این وعده برای او دیده نمی‌شود
          if (!price) continue;

          const myReservation = mine.rows.find((r) => r.offeringId === offering.id && isLiveStatus(r.status));
          const open =
            offering.status === 'Published' &&
            offering.reserveOpensAt.getTime() <= now &&
            offering.reserveDeadline.getTime() > now &&
            offering.remaining > 0;

          const deadline = computeCancelDeadline(
            { offeringCancelDeadline: offering.cancelDeadline, serviceDate: offering.serviceDate, slotStartTime: offering.slotStartTime },
            settings,
          );

          result.push({
            id: offering.id,
            serviceDate: offering.serviceDate,
            mealSlot: offering.mealSlot,
            mealSlotTitle: offering.mealSlotTitle,
            foodId: offering.foodId,
            foodName: offering.foodName,
            foodDescription: offering.foodDescription,
            imagePath: offering.foodImagePath,
            cafeteriaId: offering.cafeteriaId,
            cafeteriaName: offering.cafeteriaName,
            capacity: offering.capacity,
            reserved: offering.reservedCount,
            delivered: offering.delivered,
            cancelled: offering.cancelled,
            noShow: offering.noShow,
            remaining: offering.remaining,
            status: offering.status,
            notes: offering.notes,
            reserveOpensAt: offering.reserveOpensAt.toISOString(),
            reserveDeadline: offering.reserveDeadline.toISOString(),
            cancelDeadline: deadline.toISOString(),
            prices: offering.prices.map((p) => ({ customerGroup: p.customerGroup, priceRial: p.priceRial })),
            myPriceRial: price.priceRial,
            priceRial: price.priceRial,
            active: offering.status === 'Published',
            statusReason: offering.statusReason,
            open,
            myReservationId: myReservation?.id ?? null,
            myStatus: myReservation?.status ?? null,
          });
        }

        return {
          today,
          offerings: result,
          policyNote: settings.reservationPolicyNote,
          settings: { onlinePaymentEnabled: settings.onlinePaymentEnabled },
        };
      },
    );

    app.post(
      '/reservations',
      {
        schema: {
          body: createReservationRequestSchema,
          response: { 200: createReservationResponseSchema },
          tags: ['me'],
          summary: 'رزرو یک وعده (اتمیک، با کسر موجودی)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '5 minutes' } },
      },
      async (request) =>
        reserveMeal(deps, {
          auth: request.auth as CustomerAuth,
          offeringId: request.body.offeringId,
          idempotencyKey: request.body.idempotencyKey,
          ip: request.clientIp,
          userAgent: request.headers['user-agent'],
        }),
    );

    app.post(
      '/checkout',
      {
        schema: {
          body: checkoutRequestSchema,
          response: { 200: checkoutResponseSchema },
          tags: ['me'],
          summary: 'سبد خرید: رزرو چند وعده (بدون اعتبار رایگان)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 20), timeWindow: '5 minutes' } },
      },
      async (request) =>
        checkoutCart(deps, {
          auth: request.auth as CustomerAuth,
          items: request.body.items,
          idempotencyKey: request.body.idempotencyKey,
          ip: request.clientIp,
        }),
    );

    app.get(
      '/reservations',
      {
        schema: { response: { 200: myReservationsResponseSchema }, tags: ['me'], summary: 'رزروهای کاربر جاری با QR برای موارد فعال' },
      },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        const settings = await getSettings(deps);
        const rows = await listMyReservations(deps, auth);
        return {
          today: tehranToday(),
          reservations: rows.map((row) => {
            const deadline = computeCancelDeadline(
              { offeringCancelDeadline: row.offeringCancelDeadline, serviceDate: row.serviceDate, slotStartTime: row.slotStartTime },
              settings,
            );
            return {
              id: row.id,
              code: row.code,
              status: row.status as 'Reserved' | 'Delivered' | 'Cancelled' | 'Rejected' | 'Expired' | 'NoShow',
              priceRial: row.priceRial,
              createdAt: row.createdAt.toISOString(),
              serviceDate: row.serviceDate,
              mealSlot: row.mealSlot,
              mealSlotTitle: mealSlotLabel(row.mealSlot),
              foodName: row.foodName,
              cafeteriaName: row.cafeteriaName,
              deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
              cancelDeadline: deadline.toISOString(),
              qrToken: row.status === 'Reserved' ? row.qrToken : null,
            };
          }),
        };
      },
    );

    app.post(
      '/reservations/:id/qr/reissue',
      {
        schema: {
          params: idParams,
          response: { 200: reissueQrResponseSchema },
          tags: ['me'],
          summary: 'بازصدور QR (توکن قبلی باطل می‌شود)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 10), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        const result = await reissueQrToken(deps, { auth, reservationId: (request.params as { id: string }).id, ip: request.clientIp });
        return { id: result.id, qrToken: result.qrToken, issuedAt: result.issuedAt.toISOString() };
      },
    );

    app.get(
      '/wallet',
      { schema: { response: { 200: walletResponseSchema }, tags: ['me'], summary: 'اعتبار داخلی کیف پول: موجودی و تاریخچهٔ تراکنش‌ها' } },
      async (request) => myWallet(deps, request.auth as CustomerAuth),
    );

    app.get(
      '/notifications',
      { schema: { response: { 200: meNotificationsResponseSchema }, tags: ['me'], summary: 'اعلان‌های کاربر جاری' } },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        const settings = await getSettings(deps);
        const list = await listNotificationsForAccount(deps.db, auth.accountId, 100);
        return {
          notifications: list.map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            createdAt: n.createdAt.toISOString(),
            personal: n.personal,
            read: n.read,
          })),
          unread: await unreadCountFor(deps.db, { type: 'Account', id: auth.accountId }),
          supportText: settings.supportText,
          helpText: settings.helpText,
        };
      },
    );

    app.post(
      '/notifications/read',
      {
        schema: {
          body: markNotificationsReadRequestSchema,
          response: { 200: okResponseSchema },
          tags: ['me'],
          summary: 'علامت‌گذاری اعلان‌ها به‌عنوان خوانده‌شده',
        },
      },
      async (request) => {
        const auth = request.auth as CustomerAuth;
        await markNotificationsRead(deps.db, { type: 'Account', id: auth.accountId }, request.body.notificationIds);
        return { ok: true as const };
      },
    );
  };
}

const idParams = z.object({ id: z.uuid() });
