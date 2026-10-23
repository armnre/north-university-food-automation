import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  reportsAdvancedQuerySchema,
  reportsAdvancedResponseSchema,
  reportsSummaryQuerySchema,
  reportsSummaryResponseSchema,
} from '@food/shared';
import { contractorReport, reportsAdvanced, reportsSummary } from '../services/report.service.js';
import { toCsv, toXlsx, type CsvColumn } from '../services/export.service.js';
import type { AuthContext, ServiceDeps } from '../types.js';

const SUMMARY_COLUMNS: CsvColumn[] = [
  { header: 'تاریخ', key: 'date' },
  { header: 'وعده', key: 'mealSlotTitle' },
  { header: 'سلف', key: 'cafeteria' },
  { header: 'غذا', key: 'food' },
  { header: 'ظرفیت', key: 'capacity' },
  { header: 'رزرو', key: 'reserved' },
  { header: 'تحویل', key: 'delivered' },
  { header: 'لغو', key: 'cancelled' },
  { header: 'عدم مراجعه', key: 'noShow' },
  { header: 'ارزش (ریال)', key: 'valueRial' },
];

const LEDGER_COLUMNS: CsvColumn[] = [
  { header: 'کد رهگیری', key: 'trackingCode' },
  { header: 'نوع', key: 'type' },
  { header: 'مبلغ (ریال)', key: 'amountRial' },
  { header: 'دلیل', key: 'reason' },
  { header: 'شناسهٔ کاربر', key: 'holderIdentifier' },
  { header: 'نام', key: 'holderName' },
  { header: 'گروه مشتری', key: 'customerGroup' },
  { header: 'زمان', key: 'createdAt' },
];

/** گزارش‌های مدیریتی + خروجی CSV/Excel. */
export function reportRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/summary',
      {
        schema: {
          querystring: reportsSummaryQuerySchema,
          response: { 200: reportsSummaryResponseSchema },
          tags: ['reports'],
          summary: 'گزارش به تفکیک هر وعده',
        },
        preValidation: app.requirePermission(['reports', 'contractorReports', 'finance']),
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        if (auth.role === 'Contractor') return contractorReport(deps, auth, { from: request.query.from, to: request.query.to });
        return reportsSummary(deps, {
          from: request.query.from,
          to: request.query.to,
          cafeteriaId: request.query.cafeteriaId,
          mealSlot: request.query.mealSlot,
          customerGroup: request.query.customerGroup,
        });
      },
    );

    app.get(
      '/advanced',
      {
        schema: {
          querystring: reportsAdvancedQuerySchema,
          response: { 200: reportsAdvancedResponseSchema },
          tags: ['reports'],
          summary: 'گزارش تحلیلی (روند، غذاها، دانشکده‌ها، مالی)',
        },
        preValidation: app.requirePermission(['reports', 'finance']),
      },
      async (request) =>
        reportsAdvanced(deps, {
          from: request.query.from,
          to: request.query.to,
          cafeteriaId: request.query.cafeteriaId,
          customerGroup: request.query.customerGroup,
        }),
    );

    app.get(
      '/summary.csv',
      {
        schema: {
          querystring: reportsSummaryQuerySchema,
          response: { 200: z.string() },
          tags: ['reports'],
          summary: 'خروجی CSV گزارش وعده‌ها',
        },
        preValidation: app.requirePermission(['reports', 'contractorReports', 'finance']),
      },
      async (request, reply) => {
        const report = await reportsSummary(deps, request.query);
        void reply.header('Content-Disposition', `attachment; filename="report-${request.query.from}_${request.query.to}.csv"`);
        void reply.type('text/csv; charset=utf-8');
        return toCsv(SUMMARY_COLUMNS, report.rows as unknown as Record<string, unknown>[]);
      },
    );

    app.get(
      '/summary.xlsx',
      {
        schema: { querystring: reportsSummaryQuerySchema, tags: ['reports'], summary: 'خروجی Excel گزارش وعده‌ها' },
        preValidation: app.requirePermission(['reports', 'contractorReports', 'finance']),
      },
      async (request, reply) => {
        const report = await reportsSummary(deps, request.query);
        const buffer = await toXlsx('گزارش وعده‌ها', SUMMARY_COLUMNS, report.rows as unknown as Record<string, unknown>[]);
        void reply.header('Content-Disposition', `attachment; filename="report-${request.query.from}_${request.query.to}.xlsx"`);
        void reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return reply.send(buffer);
      },
    );

    app.get(
      '/ledger.csv',
      {
        schema: {
          querystring: z.object({
            from: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            to: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
          }),
          response: { 200: z.string() },
          tags: ['reports'],
          summary: 'خروجی CSV دفتر کل',
        },
        preValidation: app.requirePermission('finance'),
      },
      async (request, reply) => {
        const { listLedger } = await import('../services/finance.service.js');
        const ledger = await listLedger(deps, { from: request.query.from, to: request.query.to, limit: 500 });
        void reply.header('Content-Disposition', `attachment; filename="ledger-${Date.now()}.csv"`);
        void reply.type('text/csv; charset=utf-8');
        return toCsv(LEDGER_COLUMNS, ledger.entries as unknown as Record<string, unknown>[]);
      },
    );

    app.get(
      '/ledger.xlsx',
      {
        schema: {
          querystring: z.object({
            from: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            to: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
          }),
          tags: ['reports'],
          summary: 'خروجی Excel دفتر کل',
        },
        preValidation: app.requirePermission('finance'),
      },
      async (request, reply) => {
        const { listLedger } = await import('../services/finance.service.js');
        const ledger = await listLedger(deps, { from: request.query.from, to: request.query.to, limit: 500 });
        const buffer = await toXlsx('دفتر کل', LEDGER_COLUMNS, ledger.entries as unknown as Record<string, unknown>[]);
        void reply.header('Content-Disposition', `attachment; filename="ledger-${Date.now()}.xlsx"`);
        void reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return reply.send(buffer);
      },
    );
  };
}
