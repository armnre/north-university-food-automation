import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  deliveryConfirmRequestSchema,
  deliveryScanRequestSchema,
  deliveryScanResponseSchema,
  deliveryStatsResponseSchema,
  offlineManifestResponseSchema,
  offlineSyncRequestSchema,
  offlineSyncResponseSchema,
} from '@food/shared';
import type { AuthContext, ServiceDeps } from '../types.js';
import {
  confirmDelivery,
  deliveryStats,
  listOfflineConflicts,
  offlineManifest,
  scanReservation,
  syncOfflineScans,
} from '../services/delivery.service.js';

type StaffAuth = Extract<AuthContext, { kind: 'staff' }>;

/** تحویل غذا در سلف: اسکن، تأیید، آمار، فهرست آفلاین و همگام‌سازی صف. */
export function deliveryRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/scan',
      {
        schema: {
          body: deliveryScanRequestSchema,
          response: { 200: deliveryScanResponseSchema },
          tags: ['delivery'],
          summary: 'اعتبارسنجی QR بدون تحویل',
        },
        preValidation: app.requirePermission(['delivery', 'deliveryAll']),
        config: { rateLimit: { max: deps.env.RATE_LIMIT_SCAN_MAX, timeWindow: '1 minute' } },
      },
      async (request) => scanReservation(deps, { auth: request.auth as StaffAuth, qrToken: request.body.qrToken, ip: request.clientIp }),
    );

    app.post(
      '/confirm',
      {
        schema: {
          body: deliveryConfirmRequestSchema,
          response: { 200: deliveryScanResponseSchema },
          tags: ['delivery'],
          summary: 'تحویل قطعی (اتمیک، دقیقاً یک‌بار)',
        },
        preValidation: app.requirePermission(['delivery', 'deliveryAll']),
        config: { rateLimit: { max: deps.env.RATE_LIMIT_SCAN_MAX, timeWindow: '1 minute' } },
      },
      async (request) =>
        confirmDelivery(deps, {
          auth: request.auth as StaffAuth,
          qrToken: request.body.qrToken,
          ip: request.clientIp,
          clientEventId: request.body.clientEventId ?? null,
          deviceId: request.body.deviceId,
          scannedAt: request.body.scannedAt ?? null,
        }),
    );

    app.get(
      '/stats',
      {
        schema: { response: { 200: deliveryStatsResponseSchema }, tags: ['delivery'], summary: 'آمار امروز سلف و آخرین اسکن‌ها' },
        preValidation: app.requirePermission(['delivery', 'deliveryAll']),
      },
      async (request) => deliveryStats(deps, request.auth as StaffAuth),
    );

    app.get(
      '/offline-manifest',
      {
        schema: {
          querystring: z.object({ cafeteriaId: z.uuid().optional() }),
          response: { 200: offlineManifestResponseSchema },
          tags: ['delivery'],
          summary: 'فهرست آفلاین رزروهای امروز سلف (فقط hash توکن)',
        },
        preValidation: app.requirePermission(['delivery', 'deliveryAll']),
      },
      async (request) => offlineManifest(deps, request.auth as StaffAuth, request.query.cafeteriaId),
    );

    app.post(
      '/sync',
      {
        schema: {
          body: offlineSyncRequestSchema,
          response: { 200: offlineSyncResponseSchema },
          tags: ['delivery'],
          summary: 'همگام‌سازی صف اسکن آفلاین (idempotent)',
        },
        preValidation: app.requirePermission(['delivery', 'deliveryAll']),
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 60), timeWindow: '5 minutes' } },
      },
      async (request) =>
        syncOfflineScans(deps, {
          auth: request.auth as StaffAuth,
          events: request.body.events,
          ip: request.clientIp,
        }),
    );

    app.get(
      '/offline-conflicts',
      {
        schema: {
          response: { 200: z.object({ conflicts: z.array(z.record(z.string(), z.unknown())) }) },
          tags: ['delivery'],
          summary: 'مغایرت‌های همگام‌سازی آفلاین',
        },
        preValidation: app.requirePermission(['audit', 'dashboard']),
      },
      async () => ({ conflicts: (await listOfflineConflicts(deps)).map((row) => ({ ...row })) as Record<string, unknown>[] }),
    );
  };
}
