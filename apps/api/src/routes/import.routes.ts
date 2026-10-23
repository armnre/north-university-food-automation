import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  importCommitRequestSchema,
  importCommitResponseSchema,
  importListResponseSchema,
  importPreviewQuerySchema,
  importPreviewResponseSchema,
  importUndoResponseSchema,
  okResponseSchema,
} from '@food/shared';
import { AppError } from '../lib/errors.js';
import { MAX_IMPORT_BYTES } from '../services/import.service.js';
import { cancelImport, commitImport, listImportBatches, previewImport, undoImport } from '../services/import.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/**
 * واردسازی اکسل دانشجویان.
 * آپلود multipart، فقط `.xlsx`، حداکثر ۵ مگابایت و ۱۰٬۰۰۰ ردیف، پارس سمت سرور با exceljs.
 * فایل خام ذخیره نمی‌شود؛ فقط دادهٔ هش‌شده/غیرحساس در `import_rows` می‌ماند (۷ روز).
 */
export function importRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preValidation', app.requirePermission('import'));

    app.post(
      '/preview',
      {
        schema: {
          querystring: importPreviewQuerySchema,
          response: { 200: importPreviewResponseSchema },
          tags: ['imports'],
          summary: 'آپلود و پیش‌نمایش فایل دانشجویان (بدون نوشتن در Students)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 20), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const data = await request.file();
        if (!data) throw new AppError('VALIDATION', 'فایلی ارسال نشد.');
        if (data.fieldname !== 'file') throw new AppError('VALIDATION', 'نام فیلد فایل باید `file` باشد.');

        const buffer = await data.toBuffer();
        if (buffer.length > MAX_IMPORT_BYTES) {
          throw new AppError('VALIDATION', `حجم فایل نباید بیشتر از ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} مگابایت باشد.`);
        }

        return previewImport(deps, {
          buffer,
          fileName: data.filename,
          policy: request.query.policy,
          fullSync: request.query.fullSync,
          sheet: request.query.sheet,
          actor: actorOf(auth),
          staffId: auth.staffId,
          ip: request.clientIp,
        });
      },
    );

    app.get(
      '/',
      { schema: { response: { 200: importListResponseSchema }, tags: ['imports'], summary: 'فهرست دسته‌های واردسازی' } },
      async () => listImportBatches(deps),
    );

    app.post(
      '/:id/commit',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: importCommitRequestSchema,
          response: { 200: importCommitResponseSchema },
          tags: ['imports'],
          summary: 'ثبت نهایی دسته (یک تراکنش، همه یا هیچ)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 20), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        return commitImport(deps, {
          batchId: (request.params as { id: string }).id,
          approvedConflicts: request.body.approvedConflicts,
          actor: actorOf(auth),
          staffId: auth.staffId,
          ip: request.clientIp,
        });
      },
    );

    app.post(
      '/:id/cancel',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          response: { 200: okResponseSchema },
          tags: ['imports'],
          summary: 'لغو دستهٔ پیش‌نمایش',
        },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        return cancelImport(deps, { batchId: (request.params as { id: string }).id, actor: actorOf(auth), ip: request.clientIp });
      },
    );

    app.post(
      '/:id/undo',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          response: { 200: importUndoResponseSchema },
          tags: ['imports'],
          summary: 'بازگردانی آخرین دسته (فقط ردیف‌های جدید بدون فعالیت)',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 10), timeWindow: '1 hour' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        return undoImport(deps, {
          batchId: (request.params as { id: string }).id,
          actor: actorOf(auth),
          staffId: auth.staffId,
          ip: request.clientIp,
        });
      },
    );
  };
}
