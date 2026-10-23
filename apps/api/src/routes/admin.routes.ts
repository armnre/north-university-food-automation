import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminReservationsQuerySchema,
  adminReservationsResponseSchema,
  dashboardResponseSchema,
  okResponseSchema,
  studentReportResponseSchema,
  studentStatusRequestSchema,
  studentsQuerySchema,
  studentsResponseSchema,
} from '@food/shared';
import type { ServiceDeps } from '../types.js';
import { actorOf } from '../types.js';
import { adminDashboard, contractorReport } from '../services/report.service.js';
import { listStudents, setStudentStatus, studentReport } from '../services/student.service.js';
import { queryReservations } from '../repositories/reservation.repo.js';
import { getSettings } from '../services/settings.service.js';
import { computeCancelDeadline } from '../services/reservation.service.js';

/** داشبورد مدیریتی و مدیریت دانشجویان. */
export function adminRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/dashboard',
      {
        schema: { response: { 200: dashboardResponseSchema }, tags: ['admin'], summary: 'شاخص‌های داشبورد مدیریتی بر اساس نقش' },
        preValidation: app.requirePermission(['dashboard', 'contractorReports']),
      },
      async (request) => {
        const auth = request.auth as Extract<typeof request.auth, { kind: 'staff' }>;
        if (auth.role === 'Contractor') {
          const today = new Date();
          const from = new Date(today.getTime() - 13 * 86_400_000).toISOString().slice(0, 10);
          const to = new Date(today.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
          return contractorReport(deps, auth, { from, to });
        }
        return adminDashboard(deps, auth);
      },
    );

    app.get(
      '/students',
      {
        schema: {
          querystring: studentsQuerySchema,
          response: { 200: studentsResponseSchema },
          tags: ['admin'],
          summary: 'فهرست و جست‌وجوی دانشجویان',
        },
        preValidation: app.requirePermission('students'),
      },
      async (request) => listStudents(deps, request.query),
    );

    app.get(
      '/students/:id/report',
      {
        schema: { params: idParams, response: { 200: studentReportResponseSchema }, tags: ['admin'], summary: 'گزارش کامل یک دانشجو' },
        preValidation: app.requirePermission(['students', 'finance']),
      },
      async (request) => studentReport(deps, (request.params as { id: string }).id),
    );

    app.patch(
      '/students/:id/status',
      {
        schema: {
          params: idParams,
          body: studentStatusRequestSchema,
          response: { 200: okResponseSchema },
          tags: ['admin'],
          summary: 'تغییر وضعیت دانشجو',
        },
        preValidation: app.requirePermission('studentStatus'),
      },
      async (request) => {
        const auth = request.auth!;
        await setStudentStatus(deps, {
          studentId: (request.params as { id: string }).id,
          status: request.body.status,
          reason: request.body.reason,
          actor: actorOf(auth),
          ip: request.clientIp,
        });
        return { ok: true as const };
      },
    );

    // فهرست رزروها برای مدیریت (مشاهده برای معاونت، لغو اداری برای مدیر تغذیه)
    app.get(
      '/reservations',
      {
        schema: {
          querystring: adminReservationsQuery,
          response: { 200: adminReservationsResponseSchema },
          tags: ['admin'],
          summary: 'فهرست رزروها برای مدیریت',
        },
        preValidation: app.requirePermission('reservations'),
      },
      async (request) => listAdminReservations(deps, request.query as AdminReservationQuery),
    );
  };
}

const idParams = z.object({ id: z.uuid() });
const adminReservationsQuery = adminReservationsQuerySchema;
type AdminReservationQuery = z.infer<typeof adminReservationsQuerySchema>;

async function listAdminReservations(deps: ServiceDeps, query: AdminReservationQuery) {
  const settings = await getSettings(deps);
  const { rows, total } = await queryReservations(deps.db, {
    from: query.from,
    to: query.to,
    cafeteriaId: query.cafeteriaId,
    offeringId: query.offeringId,
    status: query.status,
    customerGroup: query.customerGroup,
    search: query.search,
    offset: query.offset,
    limit: query.limit,
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
    hasMore: rows.length === query.limit,
  };
}
