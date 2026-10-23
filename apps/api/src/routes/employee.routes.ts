import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import {
  employeeListQuerySchema,
  employeeListResponseSchema,
  employeeUpsertRequestSchema,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
} from '@food/shared';
import { AppError } from '../lib/errors.js';
import { MAX_IMPORT_BYTES } from '../services/import.service.js';
import { bulkCreateEmployees, listEmployees, resetEmployeePassword, saveEmployee } from '../services/employee.service.js';
import { actorOf, type AuthContext, type ServiceDeps } from '../types.js';

/**
 * کارمندان / هیئت‌علمی / پیمانکاران دانشگاه (مشتریان سلف).
 * مدیریت با معاونت دانشجویی و مدیر ارشد؛ ساخت گروهی با فایل اعتبارنامهٔ
 * **یک‌بار-دانلود** (رمزها ذخیره نمی‌شوند).
 */
export function employeeRoutes(deps: ServiceDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preValidation', app.requirePermission('employees'));

    app.get(
      '/',
      {
        schema: {
          querystring: employeeListQuerySchema,
          response: { 200: employeeListResponseSchema },
          tags: ['employees'],
          summary: 'فهرست کارمندان',
        },
      },
      async (request) => listEmployees(deps, request.query),
    );

    app.post(
      '/',
      {
        schema: {
          body: employeeUpsertRequestSchema,
          response: { 200: z.object({ id: z.uuid(), temporaryPassword: z.string().nullable() }) },
          tags: ['employees'],
          summary: 'ساخت حساب کارمند',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 60), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        return saveEmployee(deps, { data: request.body, me: auth, actor: actorOf(auth), ip: request.clientIp });
      },
    );

    app.put(
      '/:id',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: employeeUpsertRequestSchema,
          response: { 200: z.object({ id: z.uuid(), temporaryPassword: z.string().nullable() }) },
          tags: ['employees'],
          summary: 'ویرایش حساب کارمند',
        },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const { id } = request.params as { id: string };
        return saveEmployee(deps, { data: { ...request.body, id }, me: auth, actor: actorOf(auth), ip: request.clientIp });
      },
    );

    app.post(
      '/:id/reset-password',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          body: resetPasswordRequestSchema,
          response: { 200: resetPasswordResponseSchema },
          tags: ['employees'],
          summary: 'ریست رمز کارمند',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 30), timeWindow: '10 minutes' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const result = await resetEmployeePassword(deps, {
          id: (request.params as { id: string }).id,
          newPassword: request.body.newPassword,
          actor: actorOf(auth),
          ip: request.clientIp,
        });
        return { ok: true as const, temporaryPassword: result.temporaryPassword, sessionsRevoked: result.sessionsRevoked };
      },
    );

    /** ساخت گروهی از فایل اکسل (حداکثر ۳۰۰ ردیف) + فایل اعتبارنامهٔ یک‌بار-دانلود. */
    app.post(
      '/bulk',
      {
        schema: {
          response: { 200: z.object({ created: z.number().int(), skipped: z.number().int(), downloadUrl: z.string() }) },
          tags: ['employees'],
          summary: 'واردسازی گروهی کارمندان',
        },
        config: { rateLimit: { max: Math.max(deps.env.RATE_LIMIT_WRITE_MAX, 10), timeWindow: '1 hour' } },
      },
      async (request) => {
        const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
        const data = await request.file();
        if (!data) throw new AppError('VALIDATION', 'فایلی ارسال نشد.');
        const buffer = await data.toBuffer();
        if (buffer.length > MAX_IMPORT_BYTES) throw new AppError('VALIDATION', 'حجم فایل بیش از حد مجاز است.');
        if (
          !String(data.filename ?? '')
            .toLowerCase()
            .endsWith('.xlsx')
        ) {
          throw new AppError('VALIDATION', 'فقط فایل xlsx پذیرفته می‌شود.');
        }

        const workbook = new ExcelJS.Workbook();
        const asArrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        await workbook.xlsx.load(asArrayBuffer);
        const sheet = workbook.worksheets[0];
        if (!sheet) throw new AppError('VALIDATION', 'فایل هیچ شیتی ندارد.');

        const rows: {
          username: string;
          fullName: string;
          customerGroup: 'Employee' | 'Faculty' | 'Contractor';
          department?: string;
          mobile?: string;
        }[] = [];
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber === 1) return;
          const cell = (index: number): string => {
            const value = row.getCell(index).value;
            if (value == null) return '';
            if (typeof value === 'object' && 'richText' in value) return (value.richText ?? []).map((t) => t.text).join('');
            return String(value).trim();
          };
          const username = cell(1);
          if (!username) return;
          const groupText = cell(3);
          const customerGroup: 'Employee' | 'Faculty' | 'Contractor' = /هیئت|faculty/i.test(groupText)
            ? 'Faculty'
            : /پیمان|contractor/i.test(groupText)
              ? 'Contractor'
              : 'Employee';
          if (rows.length >= 300) return;
          rows.push({ username, fullName: cell(2) || username, customerGroup, department: cell(4), mobile: cell(5) });
        });

        if (rows.length === 0) throw new AppError('VALIDATION', 'فایل هیچ ردیف معتبری ندارد.');
        const result = await bulkCreateEmployees(deps, { rows, actor: actorOf(auth), staffId: auth.staffId, ip: request.clientIp });

        // فایل اعتبارنامه: فقط در حافظه ساخته و یک‌بار برگردانده می‌شود؛ ذخیره نمی‌شود
        const credentialsBuffer = await buildCredentialsWorkbook(result.credentials);
        pendingCredentials.set(auth.staffId, { buffer: credentialsBuffer, createdAt: Date.now() });
        prunePendingCredentials();

        return { created: result.created, skipped: result.skipped, downloadUrl: `/api/v1/employees/credentials` };
      },
    );

    /** دانلود یک‌بارهٔ فایل اعتبارنامه (فقط توسط همان مدیر، فقط یک بار). */
    app.get('/credentials', { schema: { tags: ['employees'], summary: 'دانلود فایل اعتبارنامهٔ یک‌بارمصرف' } }, async (request, reply) => {
      const auth = request.auth as Extract<AuthContext, { kind: 'staff' }>;
      const entry = pendingCredentials.get(auth.staffId);
      if (!entry || Date.now() - entry.createdAt > 10 * 60_000) {
        throw new AppError('NOT_FOUND', 'فایل اعتبارنامه در دسترس نیست (فقط یک بار و تا ۱۰ دقیقه پس از ساخت قابل دانلود است).');
      }
      pendingCredentials.delete(auth.staffId);
      void reply.header('Content-Disposition', `attachment; filename="employee-credentials-${new Date().toISOString().slice(0, 10)}.xlsx"`);
      void reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      void reply.header('Cache-Control', 'no-store');
      return reply.send(entry.buffer);
    });
  };
}

/** اعتبارنامه‌های تولیدشده فقط در حافظه و حداکثر ۱۰ دقیقه نگه داشته می‌شوند. */
const pendingCredentials = new Map<string, { buffer: Buffer; createdAt: number }>();

function prunePendingCredentials(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, value] of pendingCredentials) {
    if (value.createdAt < cutoff) pendingCredentials.delete(key);
  }
}

async function buildCredentialsWorkbook(credentials: { username: string; fullName: string; password: string }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('اعتبارنامه', { views: [{ rightToLeft: true }] });
  sheet.columns = [
    { header: 'نام کاربری', key: 'username', width: 24 },
    { header: 'نام و نام خانوادگی', key: 'fullName', width: 30 },
    { header: 'رمز عبور موقت', key: 'password', width: 24 },
  ];
  for (const row of credentials) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written instanceof ArrayBuffer ? new Uint8Array(written) : (written as unknown as Uint8Array));
}
