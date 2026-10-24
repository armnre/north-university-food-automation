import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STAFF_ROLES, hasAnyPermission, type Permission, type StaffRole } from '@food/shared';
import { buildApp } from '../../src/app.js';
import { readEnv, testEnv } from '../../src/config/env.js';
import { createSilentLogger } from '../../src/lib/logger.js';
import { PUBLIC_API_V1_ROUTES, normalizeRouteKey } from '../../src/plugins/auth.js';
import { getTestDb, resetDatabase, testDatabaseUrl } from '../helpers/db.js';
import { buildTestApp, createTestClient, loginStaff, primeCsrf, type TestApp, type TestClient } from '../helpers/app.js';
import { createEmployee, createStaff, createStudent, resetBaseCache, seedBase } from '../helpers/fixtures.js';

/**
 * ماتریس کامل و جامع کنترل دسترسی (RBAC):
 *  ۱. اثبات خودکار پوشش ۱۰۰٪ مسیرهای ثبت‌شده زیر `/api/v1/*` از روی جدول مسیرهای واقعی Fastify (`app.registeredRoutes`).
 *  ۲. آزمون هر مسیر مدیریتی × هر ۷ نقش کارکنان + دانشجو + کارمند + کاربر ناشناس.
 *  ۳. آزمون هر مسیر مشتری × هر ۷ نقش کارکنان + دانشجو + کارمند + کاربر ناشناس.
 *  ۴. آزمون نگهبان سراسری **Fail-Closed**: مسیر ثبت‌شده بدون مجوز صریح حتی برای `SuperAdmin` با `403` مسدود می‌شود.
 *  ۵. آزمون سلسله‌مراتب نقش‌ها، تفکیک وظایف (`SuperAdmin` در برابر `Finance`) و چرخهٔ کامل مدیریت `Employee` توسط `StudentAffairs`.
 */

const db = getTestDb();
let ctx: TestApp;

type EndpointSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** الگوی مسیر در Fastify (برای تطبیق ۱۰۰٪ با `app.registeredRoutes`). */
  routePattern: string;
  /** آدرس فراخوانی واقعی در تست (شامل پارامترهای نمونه). */
  path: string;
  allow: Permission[];
  body?: unknown;
};

const FAKE_UUID = '11111111-1111-4111-8111-111111111111';

const STAFF_ENDPOINTS: EndpointSpec[] = [
  // --- admin ---
  { method: 'GET', routePattern: '/api/v1/admin/dashboard', path: '/api/v1/admin/dashboard', allow: ['dashboard', 'contractorReports'] },
  { method: 'GET', routePattern: '/api/v1/admin/students', path: '/api/v1/admin/students', allow: ['students'] },
  {
    method: 'GET',
    routePattern: '/api/v1/admin/students/:id/report',
    path: `/api/v1/admin/students/${FAKE_UUID}/report`,
    allow: ['students', 'finance'],
  },
  {
    method: 'PATCH',
    routePattern: '/api/v1/admin/students/:id/status',
    path: `/api/v1/admin/students/${FAKE_UUID}/status`,
    allow: ['studentStatus'],
    body: { status: 'Active' },
  },
  { method: 'GET', routePattern: '/api/v1/admin/reservations', path: '/api/v1/admin/reservations', allow: ['reservations'] },

  // --- audit ---
  { method: 'GET', routePattern: '/api/v1/audit', path: '/api/v1/audit', allow: ['audit'] },
  { method: 'GET', routePattern: '/api/v1/audit/actions', path: '/api/v1/audit/actions', allow: ['audit'] },

  // --- catalog & uploads ---
  {
    method: 'GET',
    routePattern: '/api/v1/catalog',
    path: '/api/v1/catalog',
    allow: ['catalog', 'foods', 'offerings', 'reports', 'finance', 'students', 'contractorReports'],
  },
  {
    method: 'POST',
    routePattern: '/api/v1/catalog',
    path: '/api/v1/catalog',
    allow: ['foods'],
    body: { item: { kind: 'food', name: 'غذای تست ماتریس', description: '', isActive: true } },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/catalog',
    path: '/api/v1/catalog',
    allow: ['catalog'],
    body: { item: { kind: 'contractor', name: 'پیمانکار تست ماتریس', contractNumber: 'C-RBAC-1', isActive: true } },
  },
  {
    method: 'PUT',
    routePattern: '/api/v1/catalog/:kind/:id',
    path: `/api/v1/catalog/food/${FAKE_UUID}`,
    allow: ['foods'],
    body: { item: { kind: 'food', name: 'غذای ویرایشی', description: '', isActive: true } },
  },
  {
    method: 'PUT',
    routePattern: '/api/v1/catalog/:kind/:id',
    path: `/api/v1/catalog/cafeteria/${FAKE_UUID}`,
    allow: ['catalog'],
    body: { item: { kind: 'cafeteria', name: 'سلف ویرایشی', location: 'ساختمان مرکزی', isActive: true } },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/uploads/food-image',
    path: '/api/v1/uploads/food-image',
    allow: ['foods'],
    body: {},
  },

  // --- offerings ---
  {
    method: 'GET',
    routePattern: '/api/v1/offerings',
    path: '/api/v1/offerings',
    allow: ['offerings', 'delivery', 'reports', 'reservations', 'contractorReports', 'students', 'finance'],
  },
  {
    method: 'POST',
    routePattern: '/api/v1/offerings',
    path: '/api/v1/offerings',
    allow: ['offerings'],
    body: {
      serviceDate: '2026-10-25',
      mealSlot: 'Lunch',
      foodId: FAKE_UUID,
      cafeteriaId: FAKE_UUID,
      capacity: 10,
      reserveDeadline: '2026-10-25T07:00:00.000Z',
      status: 'Draft',
      notes: '',
      prices: { all: 100_000 },
    },
  },
  {
    method: 'PUT',
    routePattern: '/api/v1/offerings/:id',
    path: `/api/v1/offerings/${FAKE_UUID}`,
    allow: ['offerings'],
    body: {
      serviceDate: '2026-10-25',
      mealSlot: 'Lunch',
      foodId: FAKE_UUID,
      cafeteriaId: FAKE_UUID,
      capacity: 10,
      reserveDeadline: '2026-10-25T07:00:00.000Z',
      status: 'Draft',
      notes: '',
      prices: { all: 100_000 },
    },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/offerings/bulk',
    path: '/api/v1/offerings/bulk',
    allow: ['offerings'],
    body: { mode: 'items', items: [] },
  },
  {
    method: 'PATCH',
    routePattern: '/api/v1/offerings/:id/status',
    path: `/api/v1/offerings/${FAKE_UUID}/status`,
    allow: ['offerings'],
    body: { status: 'SoldOut', reason: 'تست دسترسی تغییر وضعیت' },
  },

  // --- reservations ---
  {
    method: 'GET',
    routePattern: '/api/v1/reservations',
    path: '/api/v1/reservations',
    allow: ['reservations', 'finance', 'students'],
  },
  {
    method: 'POST',
    routePattern: '/api/v1/reservations/:id/cancel',
    path: `/api/v1/reservations/${FAKE_UUID}/cancel`,
    allow: ['reservationCancel'],
    body: { reason: 'تست لغو اداری' },
  },

  // --- delivery ---
  {
    method: 'POST',
    routePattern: '/api/v1/delivery/scan',
    path: '/api/v1/delivery/scan',
    allow: ['delivery', 'deliveryAll'],
    body: { qrToken: 'a'.repeat(48) },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/delivery/confirm',
    path: '/api/v1/delivery/confirm',
    allow: ['delivery', 'deliveryAll'],
    body: { qrToken: 'a'.repeat(48) },
  },
  {
    method: 'GET',
    routePattern: '/api/v1/delivery/stats',
    path: '/api/v1/delivery/stats',
    allow: ['delivery', 'deliveryAll'],
  },
  {
    method: 'GET',
    routePattern: '/api/v1/delivery/offline-manifest',
    path: '/api/v1/delivery/offline-manifest',
    allow: ['delivery', 'deliveryAll'],
  },
  {
    method: 'POST',
    routePattern: '/api/v1/delivery/sync',
    path: '/api/v1/delivery/sync',
    allow: ['delivery', 'deliveryAll'],
    body: { events: [] },
  },
  {
    method: 'GET',
    routePattern: '/api/v1/delivery/offline-conflicts',
    path: '/api/v1/delivery/offline-conflicts',
    allow: ['audit', 'dashboard'],
  },

  // --- finance ---
  {
    method: 'POST',
    routePattern: '/api/v1/finance/adjust',
    path: '/api/v1/finance/adjust',
    allow: ['financeWrite'],
    body: {
      subject: 'student',
      identifier: '400000001',
      direction: 'credit',
      amountRial: 1000,
      reason: 'تست دسترسی',
      idempotencyKey: 'rbac-test-1',
    },
  },
  { method: 'GET', routePattern: '/api/v1/finance/ledger', path: '/api/v1/finance/ledger', allow: ['finance'] },
  { method: 'GET', routePattern: '/api/v1/finance/payments', path: '/api/v1/finance/payments', allow: ['finance'] },
  {
    method: 'POST',
    routePattern: '/api/v1/finance/payments/:id/resolve',
    path: `/api/v1/finance/payments/${FAKE_UUID}/resolve`,
    allow: ['financeWrite'],
    body: { action: 'mark_failed', reason: 'بررسی در پنل زرین‌پال انجام شد' },
  },
  { method: 'GET', routePattern: '/api/v1/finance/reconcile', path: '/api/v1/finance/reconcile', allow: ['finance', 'audit'] },

  // --- imports ---
  { method: 'POST', routePattern: '/api/v1/imports/preview', path: '/api/v1/imports/preview', allow: ['import'], body: {} },
  { method: 'GET', routePattern: '/api/v1/imports', path: '/api/v1/imports', allow: ['import'] },
  {
    method: 'POST',
    routePattern: '/api/v1/imports/:id/commit',
    path: `/api/v1/imports/${FAKE_UUID}/commit`,
    allow: ['import'],
    body: {},
  },
  { method: 'POST', routePattern: '/api/v1/imports/:id/cancel', path: `/api/v1/imports/${FAKE_UUID}/cancel`, allow: ['import'] },
  { method: 'POST', routePattern: '/api/v1/imports/:id/undo', path: `/api/v1/imports/${FAKE_UUID}/undo`, allow: ['import'] },

  // --- notifications ---
  { method: 'GET', routePattern: '/api/v1/notifications/admin', path: '/api/v1/notifications/admin', allow: ['notify'] },
  {
    method: 'POST',
    routePattern: '/api/v1/notifications/admin',
    path: '/api/v1/notifications/admin',
    allow: ['notify'],
    body: { title: 'تست', body: 'متن تست', audience: 'broadcast' },
  },

  // --- reports ---
  {
    method: 'GET',
    routePattern: '/api/v1/reports/summary',
    path: '/api/v1/reports/summary?from=2026-01-01&to=2026-01-02',
    allow: ['reports', 'contractorReports', 'finance'],
  },
  {
    method: 'GET',
    routePattern: '/api/v1/reports/advanced',
    path: '/api/v1/reports/advanced?from=2026-01-01&to=2026-01-02',
    allow: ['reports', 'finance'],
  },
  {
    method: 'GET',
    routePattern: '/api/v1/reports/summary.csv',
    path: '/api/v1/reports/summary.csv?from=2026-01-01&to=2026-01-02',
    allow: ['reports', 'contractorReports', 'finance'],
  },
  {
    method: 'GET',
    routePattern: '/api/v1/reports/summary.xlsx',
    path: '/api/v1/reports/summary.xlsx?from=2026-01-01&to=2026-01-02',
    allow: ['reports', 'contractorReports', 'finance'],
  },
  {
    method: 'GET',
    routePattern: '/api/v1/reports/ledger.csv',
    path: '/api/v1/reports/ledger.csv?from=2026-01-01&to=2026-01-02',
    allow: ['finance'],
  },
  {
    method: 'GET',
    routePattern: '/api/v1/reports/ledger.xlsx',
    path: '/api/v1/reports/ledger.xlsx?from=2026-01-01&to=2026-01-02',
    allow: ['finance'],
  },

  // --- settings ---
  { method: 'GET', routePattern: '/api/v1/settings', path: '/api/v1/settings', allow: ['settings'] },
  {
    method: 'PUT',
    routePattern: '/api/v1/settings',
    path: '/api/v1/settings',
    allow: ['settings'],
    body: { values: { helpText: 'تست' } },
  },

  // --- staff ---
  { method: 'GET', routePattern: '/api/v1/staff', path: '/api/v1/staff', allow: ['users', 'operators'] },
  {
    method: 'POST',
    routePattern: '/api/v1/staff',
    path: '/api/v1/staff',
    allow: ['users', 'operators'],
    body: { username: 'new.op', fullName: 'اپراتور جدید', role: 'Operator', status: 'Active', password: 'a-strong-password-1' },
  },
  {
    method: 'PUT',
    routePattern: '/api/v1/staff/:id',
    path: `/api/v1/staff/${FAKE_UUID}`,
    allow: ['users', 'operators'],
    body: { username: 'new.op', fullName: 'اپراتور', role: 'Operator', status: 'Active' },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/staff/:id/reset-password',
    path: `/api/v1/staff/${FAKE_UUID}/reset-password`,
    allow: ['users', 'operators'],
    body: { mustChangePassword: true },
  },

  // --- employees ---
  { method: 'GET', routePattern: '/api/v1/employees', path: '/api/v1/employees', allow: ['employees'] },
  {
    method: 'POST',
    routePattern: '/api/v1/employees',
    path: '/api/v1/employees',
    allow: ['employees'],
    body: { username: 'emp.rbac', fullName: 'کارمند تست', customerGroup: 'Employee', status: 'Active' },
  },
  {
    method: 'PUT',
    routePattern: '/api/v1/employees/:id',
    path: `/api/v1/employees/${FAKE_UUID}`,
    allow: ['employees'],
    body: { username: 'emp.rbac', fullName: 'کارمند تست', customerGroup: 'Employee', status: 'Active' },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/employees/:id/reset-password',
    path: `/api/v1/employees/${FAKE_UUID}/reset-password`,
    allow: ['employees'],
    body: { mustChangePassword: true },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/employees/bulk',
    path: '/api/v1/employees/bulk',
    allow: ['employees'],
    body: {},
  },
  {
    method: 'GET',
    routePattern: '/api/v1/employees/credentials',
    path: '/api/v1/employees/credentials',
    allow: ['employees'],
  },
];

/** endpointهای مخصوص مشتریان (دانشجو/کارمند) — همهٔ نقش‌های کارکنان باید ۴۰۳ بگیرند. */
const CUSTOMER_ENDPOINTS: EndpointSpec[] = [
  { method: 'GET', routePattern: '/api/v1/me/menu', path: '/api/v1/me/menu?from=2026-01-01&to=2026-01-02', allow: [] },
  { method: 'GET', routePattern: '/api/v1/me/reservations', path: '/api/v1/me/reservations', allow: [] },
  {
    method: 'POST',
    routePattern: '/api/v1/me/reservations',
    path: '/api/v1/me/reservations',
    allow: [],
    body: { offeringId: FAKE_UUID, idempotencyKey: 'rbac-test-2' },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/me/checkout',
    path: '/api/v1/me/checkout',
    allow: [],
    body: { items: [{ offeringId: FAKE_UUID }], idempotencyKey: 'rbac-test-3' },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/me/reservations/:id/qr/reissue',
    path: `/api/v1/me/reservations/${FAKE_UUID}/qr/reissue`,
    allow: [],
  },
  { method: 'GET', routePattern: '/api/v1/me/wallet', path: '/api/v1/me/wallet', allow: [] },
  { method: 'GET', routePattern: '/api/v1/me/notifications', path: '/api/v1/me/notifications', allow: [] },
  {
    method: 'POST',
    routePattern: '/api/v1/me/notifications/read',
    path: '/api/v1/me/notifications/read',
    allow: [],
    body: {},
  },
  {
    method: 'POST',
    routePattern: '/api/v1/payments/checkout/start',
    path: '/api/v1/payments/checkout/start',
    allow: [],
    body: { items: [{ offeringId: FAKE_UUID }], idempotencyKey: 'rbac-test-4' },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/payments/result',
    path: '/api/v1/payments/result',
    allow: [],
    body: { paymentId: FAKE_UUID },
  },
];

/** مسیرهای مشترک نشست برای هر کاربر احراز هویت‌شده (کاربر ناشناس باید ۴۰۱ بگیرد). */
const AUTHENTICATED_SHARED_ENDPOINTS: EndpointSpec[] = [
  { method: 'GET', routePattern: '/api/v1/auth/me', path: '/api/v1/auth/me', allow: [] },
  { method: 'GET', routePattern: '/api/v1/auth/sessions', path: '/api/v1/auth/sessions', allow: [] },
  {
    method: 'DELETE',
    routePattern: '/api/v1/auth/sessions',
    path: '/api/v1/auth/sessions',
    allow: [],
    body: { sessionId: FAKE_UUID },
  },
  {
    method: 'POST',
    routePattern: '/api/v1/auth/change-password',
    path: '/api/v1/auth/change-password',
    allow: [],
    body: { currentPassword: 'old-password-123', newPassword: 'new-strong-password-456' },
  },
  { method: 'POST', routePattern: '/api/v1/auth/logout-all', path: '/api/v1/auth/logout-all', allow: [] },
];

beforeAll(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
  ctx = await buildTestApp({
    RATE_LIMIT_READ_MAX: '50000',
    RATE_LIMIT_WRITE_MAX: '50000',
    RATE_LIMIT_AUTH_MAX: '5000',
  });
});

beforeEach(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
});

afterAll(async () => {
  await ctx?.close();
});

async function clientForRole(role: StaffRole): Promise<TestClient> {
  const { cafeterias, contractors } = await import('../../src/db/schema/index.js');
  const cafRow = (await db.select({ id: cafeterias.id }).from(cafeterias).limit(1))[0];
  let contractorId: string | null = null;
  if (role === 'Contractor') {
    const [inserted] = await db
      .insert(contractors)
      .values({ name: 'پیمانکار تست RBAC', contractNumber: `RBAC-${Date.now()}`, isActive: true })
      .returning({ id: contractors.id });
    contractorId = inserted?.id ?? null;
  }
  const staff = await createStaff(db, {
    username: `rbac.${role.toLowerCase()}`,
    role,
    cafeteriaId: role === 'Operator' ? (cafRow?.id ?? null) : null,
    contractorId,
  });
  return loginStaff(ctx.app, staff.username, staff.password);
}

describe('پوشش ۱۰۰٪ مسیرهای ثبت‌شده و نگهبان سراسری Fail-Closed', () => {
  it('۱۰۰٪ مسیرهای ثبت‌شده زیر /api/v1/* در ماتریس RBAC پوشش داده شده‌اند (هیچ route فراموش‌شده‌ای وجود ندارد)', () => {
    const coveredKeys = new Set<string>([
      ...PUBLIC_API_V1_ROUTES,
      ...STAFF_ENDPOINTS.map((e) => normalizeRouteKey(e.method, e.routePattern)),
      ...CUSTOMER_ENDPOINTS.map((e) => normalizeRouteKey(e.method, e.routePattern)),
      ...AUTHENTICATED_SHARED_ENDPOINTS.map((e) => normalizeRouteKey(e.method, e.routePattern)),
    ]);

    const actualApiV1Routes = [...ctx.app.registeredRoutes].filter((r) => r.includes(' /api/v1/')).sort();
    const unaccounted = actualApiV1Routes.filter((r) => !coveredKeys.has(r));

    expect(actualApiV1Routes.length).toBeGreaterThanOrEqual(60);
    expect(unaccounted, 'مسیرهایی زیر /api/v1/* ثبت شده‌اند که در ماتریس تست RBAC فهرست نشده‌اند').toEqual([]);
  });

  it('نگهبان Fail-Closed: اگر مسیری زیر /api/v1/* بدون مجوز ثبت شود، حتی برای SuperAdmin با ۴۰۳ مسدود می‌شود', async () => {
    const parsed = readEnv(
      testEnv({
        DATABASE_URL: testDatabaseUrl(),
        RATE_LIMIT_READ_MAX: '5000',
        RATE_LIMIT_WRITE_MAX: '5000',
      }) as NodeJS.ProcessEnv,
    );
    if (!parsed.ok) throw new Error(parsed.issues.join(' | '));

    const probeApp = await buildApp({ env: parsed.env, db, logger: createSilentLogger() });
    let handlerExecuted = false;

    // ثبت عمدی دو مسیر بدون هیچ preValidation / requirePermission
    probeApp.get('/api/v1/internal-unguarded-probe', async () => {
      handlerExecuted = true;
      return { leaked: true };
    });
    probeApp.post('/api/v1/internal-unguarded-probe', async () => {
      handlerExecuted = true;
      return { leaked: true };
    });
    await probeApp.ready();

    try {
      // ۱) کاربر ناشناس
      const anon = createTestClient(probeApp);
      await primeCsrf(anon);
      expect((await anon.get('/api/v1/internal-unguarded-probe')).status).toBe(403);
      expect((await anon.post('/api/v1/internal-unguarded-probe', {})).status).toBe(403);

      // ۲) دانشجو
      const student = await createStudent(db);
      const studentClient = createTestClient(probeApp);
      await primeCsrf(studentClient);
      await studentClient.post('/api/v1/auth/student/login', {
        studentNumber: student.studentNumber,
        nationalId: student.nationalId,
      });
      expect((await studentClient.get('/api/v1/internal-unguarded-probe')).status).toBe(403);

      // ۳) کارمند (مشتری)
      const employee = await createEmployee(db);
      const empClient = createTestClient(probeApp);
      await primeCsrf(empClient);
      await empClient.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });
      expect((await empClient.get('/api/v1/internal-unguarded-probe')).status).toBe(403);

      // ۴) مدیر ارشد (SuperAdmin)
      const superAdmin = await createStaff(db, { username: 'probe.superadmin', role: 'SuperAdmin' });
      const adminClient = await loginStaff(probeApp, superAdmin.username, superAdmin.password);
      expect((await adminClient.get('/api/v1/internal-unguarded-probe')).status).toBe(403);
      expect((await adminClient.post('/api/v1/internal-unguarded-probe', {})).status).toBe(403);

      expect(handlerExecuted).toBe(false);
    } finally {
      await probeApp.close();
    }
  });
});

describe('ماتریس کامل RBAC: هر route ثبت‌شده × هر نقش', () => {
  for (const role of STAFF_ROLES) {
    it(`نقش ${role} فقط به endpointهای مجاز خود دسترسی دارد و از تمام مسیرهای مشتری ۴۰۳ می‌گیرد`, async () => {
      const client = await clientForRole(role);
      const violations: string[] = [];
      const allowedBut403: string[] = [];

      for (const endpoint of STAFF_ENDPOINTS) {
        const permitted = hasAnyPermission(role, endpoint.allow);
        const response = await callEndpoint(client, endpoint);
        if (!permitted && response.status !== 403) {
          violations.push(`${endpoint.method} ${endpoint.path} ⇒ ${response.status} (باید ۴۰۳ باشد)`);
        }
        if (permitted && response.status === 403) {
          allowedBut403.push(`${endpoint.method} ${endpoint.path} ⇒ ۴۰۳ (باید مجاز باشد)`);
        }
      }

      for (const customerEndpoint of CUSTOMER_ENDPOINTS) {
        const response = await callEndpoint(client, customerEndpoint);
        if (response.status !== 403) {
          violations.push(`${customerEndpoint.method} ${customerEndpoint.path} ⇒ ${response.status} (برای کارکنان باید ۴۰۳ باشد)`);
        }
      }

      expect(violations, `نقش ${role} به مسیرهای غیرمجاز دسترسی داشت`).toEqual([]);
      expect(allowedBut403, `نقش ${role} از مسیرهای مجاز خود ۴۰۳ گرفت`).toEqual([]);
    });
  }

  it('دانشجو و کارمند به هیچ‌یک از endpointهای مدیریتی دسترسی ندارند ولی به مسیرهای مشتری دسترسی دارند', async () => {
    const student = await createStudent(db);
    const employee = await createEmployee(db);

    const studentClient = createTestClient(ctx.app);
    await primeCsrf(studentClient);
    await studentClient.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });

    const employeeClient = createTestClient(ctx.app);
    await primeCsrf(employeeClient);
    await employeeClient.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });

    for (const [label, client] of [
      ['Student', studentClient],
      ['Employee', employeeClient],
    ] as const) {
      const staffViolations: string[] = [];
      for (const endpoint of STAFF_ENDPOINTS) {
        const response = await callEndpoint(client, endpoint);
        if (response.status !== 403) {
          staffViolations.push(`${label}: ${endpoint.method} ${endpoint.path} ⇒ ${response.status}`);
        }
      }
      expect(staffViolations).toEqual([]);

      const customer403: string[] = [];
      for (const endpoint of CUSTOMER_ENDPOINTS) {
        const response = await callEndpoint(client, endpoint);
        if (response.status === 403 || response.status === 401) {
          customer403.push(`${label}: ${endpoint.method} ${endpoint.path} ⇒ ${response.status}`);
        }
      }
      expect(customer403).toEqual([]);
    }
  });

  it('کاربر بدون نشست از تمام مسیرهای غیرعمومی ۴۰۱ می‌گیرد', async () => {
    const anonymous = createTestClient(ctx.app);
    await primeCsrf(anonymous);
    const non401: string[] = [];
    for (const endpoint of [...AUTHENTICATED_SHARED_ENDPOINTS, ...CUSTOMER_ENDPOINTS, ...STAFF_ENDPOINTS]) {
      const response = await callEndpoint(anonymous, endpoint);
      if (response.status !== 401) {
        non401.push(`${endpoint.method} ${endpoint.path} ⇒ ${response.status}`);
      }
    }
    expect(non401).toEqual([]);
  });
});

describe('سلسله‌مراتب ساخت حساب کارکنان و چرخهٔ کامل مدیریت کارمندان (Employee)', () => {
  it('هیچ نقشی نمی‌تواند حساب هم‌سطح یا بالاتر بسازد', async () => {
    const studentAffairs = await createStaff(db, { username: 'h.sa', role: 'StudentAffairs' });
    const nutrition = await createStaff(db, { username: 'h.nm', role: 'NutritionManager' });
    const finance = await createStaff(db, { username: 'h.fin', role: 'Finance' });
    const superAdmin = await createStaff(db, { username: 'h.sa2', role: 'SuperAdmin' });

    const saClient = await loginStaff(ctx.app, studentAffairs.username, studentAffairs.password);
    const saCreatesOperator = await saClient.post('/api/v1/staff', {
      username: 'x.op',
      fullName: 'اپراتور',
      role: 'Operator',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(saCreatesOperator.status).toBe(403);

    const nmClient = await loginStaff(ctx.app, nutrition.username, nutrition.password);
    expect(
      (
        await nmClient.post('/api/v1/staff', {
          username: 'x.sa',
          fullName: 'معاونت',
          role: 'StudentAffairs',
          status: 'Active',
          password: 'a-strong-password-1',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await nmClient.post('/api/v1/staff', {
          username: 'x.root',
          fullName: 'مدیر ارشد',
          role: 'SuperAdmin',
          status: 'Active',
          password: 'a-strong-password-1',
        })
      ).status,
    ).toBe(403);

    const finClient = await loginStaff(ctx.app, finance.username, finance.password);
    expect(
      (
        await finClient.post('/api/v1/staff', {
          username: 'x.op2',
          fullName: 'اپراتور',
          role: 'Operator',
          status: 'Active',
          password: 'a-strong-password-1',
        })
      ).status,
    ).toBe(403);

    const adminClient = await loginStaff(ctx.app, superAdmin.username, superAdmin.password);
    expect(
      (
        await adminClient.post('/api/v1/staff', {
          username: 'x.root2',
          fullName: 'مدیر ارشد دوم',
          role: 'SuperAdmin',
          status: 'Active',
          password: 'a-strong-password-1',
        })
      ).status,
    ).toBe(403);
  });

  it('مدیر تغذیه می‌تواند Operator بسازد و مدیر ارشد همهٔ نقش‌های پایین‌تر را', async () => {
    const { cafeterias } = await import('../../src/db/schema/index.js');
    const cafeteria = await db.select({ id: cafeterias.id }).from(cafeterias).limit(1);
    const cafeteriaId = cafeteria[0]?.id ?? null;

    const nutrition = await createStaff(db, { username: 'h.nm2', role: 'NutritionManager' });
    const nmClient = await loginStaff(ctx.app, nutrition.username, nutrition.password);
    const created = await nmClient.post('/api/v1/staff', {
      username: 'ok.op',
      fullName: 'اپراتور سلف',
      role: 'Operator',
      status: 'Active',
      cafeteriaId,
      password: 'a-strong-password-1',
    });
    expect(created.status).toBe(200);
    expect((created.body as { id?: string }).id).toBeTruthy();

    const superAdmin = await createStaff(db, { username: 'h.root', role: 'SuperAdmin' });
    const adminClient = await loginStaff(ctx.app, superAdmin.username, superAdmin.password);
    const createdFinance = await adminClient.post('/api/v1/staff', {
      username: 'ok.fin',
      fullName: 'مسئول مالی',
      role: 'Finance',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(createdFinance.status).toBe(200);
  });

  it('ویرایش حساب هم‌سطح یا بالاتر ممنوع است', async () => {
    const first = await createStaff(db, { username: 'e.root1', role: 'SuperAdmin' });
    const second = await createStaff(db, { username: 'e.root2', role: 'SuperAdmin' });
    const client = await loginStaff(ctx.app, first.username, first.password);
    const response = await client.put(`/api/v1/staff/${second.id}`, {
      username: second.username,
      fullName: 'تغییر نام',
      role: 'SuperAdmin',
      status: 'Disabled',
    });
    expect(response.status).toBe(403);
  });

  it('معاونت دانشجویی چرخهٔ کامل مدیریت Employee (ساخت، ویرایش، غیرفعال‌سازی با ابطال نشست، ریست رمز و ایمپورت با فایل یک‌بارمصرف) را انجام می‌دهد', async () => {
    const studentAffairs = await createStaff(db, { username: 'e.sa', role: 'StudentAffairs' });
    const client = await loginStaff(ctx.app, studentAffairs.username, studentAffairs.password);

    // ۱. ساخت تکی کارمند با رمز موقت خودکار
    const created = await client.post('/api/v1/employees', {
      username: 'emp.single',
      fullName: 'مهندس نادر کریمی',
      customerGroup: 'Faculty',
      department: 'فنی و مهندسی',
      status: 'Active',
    });
    expect(created.status).toBe(200);
    const empBody = created.body as { id: string; temporaryPassword: string };
    expect(empBody.temporaryPassword).toBeTruthy();

    // ورود کارمند با رمز موقت
    const empSession = createTestClient(ctx.app);
    await primeCsrf(empSession);
    expect(
      (await empSession.post('/api/v1/auth/employee/login', { username: 'emp.single', password: empBody.temporaryPassword })).status,
    ).toBe(200);
    expect((await empSession.get('/api/v1/auth/me')).status).toBe(200);

    // ۲. غیرفعال‌سازی حساب کارمند ⇒ ابطال فوری نشست فعال
    const disabled = await client.put(`/api/v1/employees/${empBody.id}`, {
      username: 'emp.single',
      fullName: 'دکتر نادر کریمی',
      customerGroup: 'Faculty',
      department: 'فنی و مهندسی',
      status: 'Disabled',
    });
    expect(disabled.status).toBe(200);
    expect((await empSession.get('/api/v1/auth/me')).status).toBe(401);

    // ۳. فعال‌سازی مجدد + ریست رمز عبور یک‌بارمصرف
    await client.put(`/api/v1/employees/${empBody.id}`, {
      username: 'emp.single',
      fullName: 'دکتر نادر کریمی',
      customerGroup: 'Faculty',
      status: 'Active',
    });
    const resetRes = await client.post(`/api/v1/employees/${empBody.id}/reset-password`, {});
    expect(resetRes.status).toBe(200);
    expect((resetRes.body as { temporaryPassword: string }).temporaryPassword).toBeTruthy();

    // ۴. واردسازی گروهی با فایل اکسل و دانلود یک‌بارمصرف اعتبارنامه‌ها
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow(['نام کاربری', 'نام و نام خانوادگی', 'گروه', 'واحد', 'موبایل']);
    ws.addRow(['emp.bulk1', 'مریم حسینی', 'کارمند', 'آموزش', '09111234567']);
    ws.addRow(['emp.bulk2', 'دکتر بهرام علوی', 'هیئت علمی', 'علوم پایه', '09117654321']);
    const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());

    const bulkRes = await client.upload('/api/v1/employees/bulk', {
      name: 'employees.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: xlsxBuf,
    });
    expect(bulkRes.status).toBe(200);
    expect((bulkRes.body as { created: number }).created).toBe(2);

    // اولین دانلود فایل اعتبارنامه‌ها موفق است؛ دومین دانلود ۴۰۴ برمی‌گرداند (حذف فوری از حافظه)
    const firstDownload = await client.get('/api/v1/employees/credentials');
    expect(firstDownload.status).toBe(200);
    const secondDownload = await client.get('/api/v1/employees/credentials');
    expect(secondDownload.status).toBe(404);
  });

  it('تفکیک وظایف: مدیر ارشد financeWrite ندارد و امور مالی settings ندارد', async () => {
    const superAdmin = await createStaff(db, { username: 'sod.root', role: 'SuperAdmin' });
    const finance = await createStaff(db, { username: 'sod.fin', role: 'Finance' });

    const adminClient = await loginStaff(ctx.app, superAdmin.username, superAdmin.password);
    const adjustByAdmin = await adminClient.post('/api/v1/finance/adjust', {
      subject: 'student',
      identifier: '400000001',
      direction: 'credit',
      amountRial: 10_000,
      reason: 'تست تفکیک وظایف',
      idempotencyKey: 'sod-admin-1234',
    });
    expect(adjustByAdmin.status).toBe(403);

    const financeClient = await loginStaff(ctx.app, finance.username, finance.password);
    expect((await financeClient.get('/api/v1/settings')).status).toBe(403);
    expect((await financeClient.get('/api/v1/audit')).status).toBe(403);
  });
});

async function callEndpoint(client: TestClient, endpoint: EndpointSpec): Promise<{ status: number; body: unknown; raw: string }> {
  switch (endpoint.method) {
    case 'GET':
      return client.get(endpoint.path);
    case 'POST':
      return client.post(endpoint.path, endpoint.body ?? {});
    case 'PUT':
      return client.put(endpoint.path, endpoint.body ?? {});
    case 'PATCH':
      return client.patch(endpoint.path, endpoint.body ?? {});
    default:
      return client.delete(endpoint.path, endpoint.body);
  }
}
