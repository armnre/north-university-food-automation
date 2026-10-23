import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { catalogResponseSchema, catalogSaveRequestSchema } from '@food/shared';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from '../types.js';
import { actorOf } from '../types.js';
import { listCatalog, saveCatalogItem } from '../services/catalog.service.js';

/** کاتالوگ: پیمانکاران، سلف‌ها و غذاها. */
export function catalogRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/',
      {
        schema: { response: { 200: catalogResponseSchema }, tags: ['catalog'], summary: 'فهرست پیمانکاران، سلف‌ها، غذاها و وعده‌ها' },
        preValidation: app.requirePermission(['catalog', 'foods', 'offerings', 'reports', 'finance', 'students', 'contractorReports']),
      },
      async () => listCatalog(deps.db),
    );

    app.post(
      '/',
      {
        schema: {
          body: catalogSaveRequestSchema,
          response: { 200: z.object({ id: z.uuid() }) },
          tags: ['catalog'],
          summary: 'ساخت آیتم کاتالوگ',
        },
        preValidation: (request) => requireCatalogWrite(app, request, undefined),
      },
      async (request) => saveCatalogItem(deps, { item: request.body.item, actor: actorOf(request.auth!), ip: request.clientIp }),
    );

    app.put(
      '/:kind/:id',
      {
        schema: {
          params: z.object({ kind: z.enum(['contractor', 'cafeteria', 'food']), id: z.uuid() }),
          body: catalogSaveRequestSchema,
          response: { 200: z.object({ id: z.uuid() }) },
          tags: ['catalog'],
          summary: 'به‌روزرسانی آیتم کاتالوگ',
        },
        preValidation: (request) => requireCatalogWrite(app, request, (request.params as { kind?: string }).kind),
      },
      async (request) => {
        const { kind, id } = request.params as { kind: 'contractor' | 'cafeteria' | 'food'; id: string };
        if (request.body.item.kind !== kind) {
          throw new AppError('VALIDATION', 'نوع آیتم با مسیر درخواست مطابقت ندارد.');
        }
        return saveCatalogItem(deps, { item: { ...request.body.item, id }, actor: actorOf(request.auth!), ip: request.clientIp });
      },
    );
  };
}

/** مجوز نوشتن: `foods` برای غذا و `catalog` برای پیمانکار/سلف. */
async function requireCatalogWrite(app: FastifyInstance, request: FastifyRequest, kindFromPath?: string): Promise<void> {
  const kind = kindFromPath ?? (request.body as { item?: { kind?: string } } | undefined)?.item?.kind;
  await app.requirePermission(kind === 'food' ? 'foods' : 'catalog')(request);
}
