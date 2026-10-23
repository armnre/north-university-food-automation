import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  financeAdjustRequestSchema,
  financeAdjustResponseSchema,
  financeLedgerQuerySchema,
  financeLedgerResponseSchema,
  withdrawalDtoSchema,
  withdrawalReviewRequestSchema,
} from '@food/shared';
import { listLedger, listWithdrawals, manualAdjust, revealIbanForFinance, reviewWithdrawal } from '../services/finance.service.js';
import { reconcileLedger } from '../services/ledger.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/** مالی: شارژ/برداشت دستی، دفتر کل، برداشت وجه و گزارش تطبیق. */
export function financeRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/adjust',
      {
        schema: {
          body: financeAdjustRequestSchema,
          response: { 200: financeAdjustResponseSchema },
          tags: ['finance'],
          summary: 'شارژ یا برداشت دستی کیف پول',
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
      '/withdrawals',
      {
        schema: {
          querystring: z.object({
            status: z.string().max(20).optional(),
            offset: z.coerce.number().int().min(0).default(0),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
          response: { 200: z.object({ withdrawals: z.array(withdrawalDtoSchema) }) },
          tags: ['finance'],
          summary: 'درخواست‌های برداشت وجه (شبا ماسک‌شده)',
        },
        preValidation: app.requirePermission(['finance', 'financeWrite', 'withdrawalReview']),
      },
      async (request) => ({ withdrawals: await listWithdrawals(deps, request.query) }),
    );

    app.post(
      '/withdrawals/:id/review',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: withdrawalReviewRequestSchema,
          response: { 200: withdrawalDtoSchema },
          tags: ['finance'],
          summary: 'تأیید/رد/ثبت پرداخت برداشت',
        },
        preValidation: app.requirePermission(['withdrawalReview', 'financeWrite']),
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 60), timeWindow: '5 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const { id } = request.params as { id: string };
        const result = await reviewWithdrawal(deps, {
          id,
          action: request.body.action,
          reason: request.body.reason,
          bankReference: request.body.bankReference,
          actor: actorOf(auth),
          staffId: auth.staffId,
          ip: request.clientIp,
        });
        return {
          id: result.id,
          amountRial: result.amountRial,
          status: result.status,
          ibanMasked: await revealIbanForFinance(deps, result.id),
          createdAt: new Date().toISOString(),
          reviewedAt: new Date().toISOString(),
          paidAt: result.status === 'Paid' ? new Date().toISOString() : null,
          reason: request.body.reason ?? null,
          bankReference: request.body.bankReference ?? null,
          holderIdentifier: null,
          holderName: null,
        };
      },
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
