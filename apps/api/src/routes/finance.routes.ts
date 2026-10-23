import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  financeAdjustRequestSchema,
  financeAdjustResponseSchema,
  financeLedgerQuerySchema,
  financeLedgerResponseSchema,
} from '@food/shared';
import { listLedger, manualAdjust } from '../services/finance.service.js';
import { reconcileLedger } from '../services/ledger.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/** مالی: شارژ/برداشت دستی (اصلاحات مالی)، دفتر کل و گزارش تطبیق. */
export function financeRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/adjust',
      {
        schema: {
          body: financeAdjustRequestSchema,
          response: { 200: financeAdjustResponseSchema },
          tags: ['finance'],
          summary: 'شارژ یا برداشت دستی اعتبار کیف پول توسط امور مالی',
        },
        preValidation: app.requirePermission('financeWrite'),
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 60), timeWindow: '5 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        return manualAdjust(deps, {
          actor: actorOf(auth),
          staffId: auth.staffId,
          subject: request.body.subject,
          identifier: request.body.identifier,
          direction: request.body.direction,
          amountRial: request.body.amountRial,
          reason: request.body.reason,
          idempotencyKey: request.body.idempotencyKey,
          ip: request.clientIp,
        });
      },
    );

    app.get(
      '/ledger',
      {
        schema: {
          querystring: financeLedgerQuerySchema,
          response: { 200: financeLedgerResponseSchema },
          tags: ['finance'],
          summary: 'دفتر کل با جمع، ماندهٔ حساب‌های سیستمی و مغایرت‌ها',
        },
        preValidation: app.requirePermission('finance'),
      },
      async (request) => listLedger(deps, request.query),
    );

    app.get(
      '/reconcile',
      {
        schema: {
          response: {
            200: z.object({
              checkedAccounts: z.number().int(),
              checkedTransactions: z.number().int(),
              unbalancedTransactions: z.array(z.object({ transactionId: z.string(), total: z.number().int() })),
              balanceMismatches: z.array(z.object({ accountId: z.string(), cached: z.number().int(), ledger: z.number().int() })),
            }),
          },
          tags: ['finance'],
          summary: 'گزارش تطبیق دفتر کل (برابری موجودی کش‌شده با مجموع ورودی‌ها)',
        },
        preValidation: app.requirePermission(['finance', 'audit']),
      },
      async () => reconcileLedger(deps.db),
    );
  };
}
