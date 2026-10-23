import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STAFF_ROLES, hasAnyPermission, type Permission, type StaffRole } from '@food/shared';
import { getTestDb, resetDatabase } from '../helpers/db.js';
import { buildTestApp, createTestClient, loginStaff, primeCsrf, type TestApp, type TestClient } from '../helpers/app.js';
import { createEmployee, createStaff, createStudent, resetBaseCache, seedBase } from '../helpers/fixtures.js';

/**
 * ماتریس کامل نقش × endpoint.
 *
 * برای هر endpoint، فهرست مجوزهای مجاز (`allow`) اعلام می‌شود؛ سپس هر نقش
 * آن را صدا می‌زند:
 *  - نقشی که هیچ‌کدام از مجوزها را ندارد ⇒ باید **۴۰۳** بگیرد (پیش‌فرض: رد)
 *  - نقشی که مجوز دارد ⇒ نباید ۴۰۳ بگیرد (ممکن است ۲۰۰/۴۰۰/۴۰۴/۴۰۹ باشد)
 *
 * مجوزهای هر endpoint باید با `docs/RBAC.md` یکی باشد.
 */

const db = getTestDb();
let ctx: TestApp;

type EndpointSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  allow: Permission[];
  body?: unknown;
};

const FAKE_UUID = '11111111-1111-4111-8111-111111111111';

const STAFF_ENDPOINTS: EndpointSpec[] = [
  { method: 'GET', path: '/api/v1/admin/dashboard', allow: ['dashboard', 'contractorReports'] },
  { method: 'GET', path: '/api/v1/admin/students', allow: ['students'] },
  { method: 'GET', path: `/api/v1/admin/students/${FAKE_UUID}/report`, allow: ['students', 'finance'] },
  { method: 'PATCH', path: `/api/v1/admin/students/${FAKE_UUID}/status`, allow: ['studentStatus'], body: { status: 'Active' } },
  { method: 'GET', path: '/api/v1/admin/reservations', allow: ['reservations'] },
  { method: 'GET', path: '/api/v1/audit', allow: ['audit'] },
  { method: 'GET', path: '/api/v1/audit/actions', allow: ['audit'] },
  {
    method: 'GET',
    path: '/api/v1/catalog',
    allow: ['catalog', 'foods', 'offerings', 'reports', 'finance', 'students', 'contractorReports'],
  },
  {
    method: 'POST',
    path: '/api/v1/catalog',
    allow: ['foods'],
    body: { item: { kind: 'food', name: 'غذای تست', description: '', isActive: true } },
  },
  {
    method: 'GET',
    path: '/api/v1/offerings',
    allow: ['offerings', 'delivery', 'reports', 'reservations', 'contractorReports', 'students', 'finance'],
  },
  { method: 'POST', path: '/api/v1/offerings/bulk', allow: ['offerings'], body: { mode: 'items', items: [] } },
  {
    method: 'PATCH',
    path: `/api/v1/offerings/${FAKE_UUID}/status`,
    allow: ['offerings'],
    body: { status: 'SoldOut', reason: 'تست دسترسی' },
  },
  { method: 'GET', path: '/api/v1/reservations', allow: ['reservations', 'finance', 'students'] },
  { method: 'POST', path: `/api/v1/reservations/${FAKE_UUID}/cancel`, allow: ['reservationCancel'], body: { reason: 'تست لغو اداری' } },
  { method: 'POST', path: '/api/v1/delivery/scan', allow: ['delivery', 'deliveryAll'], body: { qrToken: 'a'.repeat(48) } },
  { method: 'POST', path: '/api/v1/delivery/confirm', allow: ['delivery', 'deliveryAll'], body: { qrToken: 'a'.repeat(48) } },
  { method: 'GET', path: '/api/v1/delivery/stats', allow: ['delivery', 'deliveryAll'] },
  { method: 'GET', path: '/api/v1/delivery/offline-manifest', allow: ['delivery', 'deliveryAll'] },
  { method: 'GET', path: '/api/v1/delivery/offline-conflicts', allow: ['audit', 'dashboard'] },
  {
    method: 'POST',
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
  { method: 'GET', path: '/api/v1/finance/ledger', allow: ['finance'] },
  { method: 'GET', path: '/api/v1/finance/withdrawals', allow: ['finance', 'financeWrite', 'withdrawalReview'] },
  {
    method: 'POST',
    path: `/api/v1/finance/withdrawals/${FAKE_UUID}/review`,
    allow: ['withdrawalReview', 'financeWrite'],
    body: { action: 'approve' },
  },
  { method: 'GET', path: '/api/v1/finance/reconcile', allow: ['finance', 'audit'] },
  { method: 'GET', path: '/api/v1/imports', allow: ['import'] },
  { method: 'POST', path: `/api/v1/imports/${FAKE_UUID}/commit`, allow: ['import'], body: {} },
  { method: 'POST', path: `/api/v1/imports/${FAKE_UUID}/cancel`, allow: ['import'] },
  { method: 'POST', path: `/api/v1/imports/${FAKE_UUID}/undo`, allow: ['import'] },
  { method: 'GET', path: '/api/v1/notifications/admin', allow: ['notify'] },
  {
    method: 'POST',
    path: '/api/v1/notifications/admin',
    allow: ['notify'],
    body: { title: 'تست', body: 'متن تست', audience: 'broadcast' },
  },
  { method: 'GET', path: '/api/v1/reports/summary?from=2026-01-01&to=2026-01-02', allow: ['reports', 'contractorReports', 'finance'] },
  { method: 'GET', path: '/api/v1/reports/advanced?from=2026-01-01&to=2026-01-02', allow: ['reports', 'finance'] },
  { method: 'GET', path: '/api/v1/settings', allow: ['settings'] },
  { method: 'PUT', path: '/api/v1/settings', allow: ['settings'], body: { values: { helpText: 'تست' } } },
  {
    method: 'POST',
    path: '/api/v1/staff',
    allow: ['users', 'operators'],
    body: { username: 'new.op', fullName: 'اپراتور جدید', role: 'Operator', status: 'Active', password: 'a-strong-password-1' },
  },
  {
    method: 'PUT',
    path: `/api/v1/staff/${FAKE_UUID}`,
    allow: ['users', 'operators'],
    body: { username: 'new.op', fullName: 'اپراتور', role: 'Operator', status: 'Active' },
  },
  { method: 'POST', path: `/api/v1/staff/${FAKE_UUID}/reset-password`, allow: ['users', 'operators'], body: { mustChangePassword: true } },
  { method: 'GET', path: '/api/v1/employees', allow: ['employees'] },
  {
    method: 'POST',
    path: '/api/v1/employees',
    allow: ['employees'],
    body: { username: 'emp.rbac', fullName: 'کارمند تست', customerGroup: 'Employee', status: 'Active' },
  },
  {
    method: 'PUT',
    path: `/api/v1/employees/${FAKE_UUID}`,
    allow: ['employees'],
    body: { username: 'emp.rbac', fullName: 'کارمند تست', customerGroup: 'Employee', status: 'Active' },
  },
  { method: 'POST', path: `/api/v1/employees/${FAKE_UUID}/reset-password`, allow: ['employees'], body: { mustChangePassword: true } },
];

/** endpointهای مخصوص مشتریان (دانشجو/کارمند) — کارکنان باید ۴۰۳ بگیرند. */
const CUSTOMER_ENDPOINTS: EndpointSpec[] = [
  { method: 'GET', path: '/api/v1/me/menu?from=2026-01-01&to=2026-01-02', allow: [] },
  { method: 'GET', path: '/api/v1/me/reservations', allow: [] },
  { method: 'GET', path: '/api/v1/me/wallet', allow: [] },
  { method: 'GET', path: '/api/v1/me/notifications', allow: [] },
  { method: 'POST', path: '/api/v1/me/reservations', allow: [], body: { offeringId: FAKE_UUID, idempotencyKey: 'rbac-test-2' } },
  { method: 'POST', path: '/api/v1/me/checkout', allow: [], body: { items: [{ offeringId: FAKE_UUID }], idempotencyKey: 'rbac-test-3' } },
  { method: 'POST', path: '/api/v1/me/wallet/topup', allow: [], body: { amountRial: 100000, returnTo: '/wallet' } },
  { method: 'POST', path: '/api/v1/me/withdrawals', allow: [], body: { amountRial: 100000, iban: 'IR000000000000000000000000' } },
];

beforeAll(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
  ctx = await buildTestApp();
});

beforeEach(async () => {
  await resetDatabase();
  resetBaseCache();
  await seedBase(db);
});

afterAll(async () => {
  await ctx?.close();
});

/** برای هر تست یک کاربر تازه (چون پایگاه داده بین تست‌ها پاک می‌شود). */
async function clientForRole(role: StaffRole): Promise<TestClient> {
  const staff = await createStaff(db, { username: `rbac.${role.toLowerCase()}`, role });
  return loginStaff(ctx.app, staff.username, staff.password);
}

describe('ماتریس RBAC: نقش × endpoint', () => {
  for (const role of STAFF_ROLES) {
    it(`نقش ${role} فقط به endpointهای مجاز خود دسترسی دارد`, async () => {
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

      expect(violations, `نقش ${role} به مسیرهای غیرمجاز دسترسی داشت`).toEqual([]);
      expect(allowedBut403, `نقش ${role} از مسیرهای مجاز خود ۴۰۳ گرفت`).toEqual([]);
    });
  }

  it('کارکنان به endpointهای مشتریان (دانشجو/کارمند) دسترسی ندارند', async () => {
    const admin = await createStaff(db, { username: 'rbac.probe', role: 'SuperAdmin' });
    const client = await loginStaff(ctx.app, admin.username, admin.password);
    for (const endpoint of CUSTOMER_ENDPOINTS) {
      const response = await callEndpoint(client, endpoint);
      expect(response.status, `${endpoint.method} ${endpoint.path} باید برای کارکنان ۴۰۳ باشد`).toBe(403);
    }
  });

  it('دانشجو و کارمند به هیچ endpoint مدیریتی دسترسی ندارند', async () => {
    const student = await createStudent(db);
    const employee = await createEmployee(db);

    const studentClient = createTestClient(ctx.app);
    await primeCsrf(studentClient);
    await studentClient.post('/api/v1/auth/student/login', { studentNumber: student.studentNumber, nationalId: student.nationalId });

    const employeeClient = createTestClient(ctx.app);
    await primeCsrf(employeeClient);
    await employeeClient.post('/api/v1/auth/employee/login', { username: employee.username, password: employee.password });

    for (const client of [studentClient, employeeClient]) {
      for (const endpoint of STAFF_ENDPOINTS) {
        const response = await callEndpoint(client, endpoint);
        expect(response.status, `${endpoint.method} ${endpoint.path} باید برای مشتری ۴۰۳ باشد`).toBe(403);
      }
    }
  });

  it('کاربر بدون نشست ۴۰۱ می‌گیرد (نه ۴۰۳ و نه داده)', async () => {
    const anonymous = createTestClient(ctx.app);
    await primeCsrf(anonymous);
    for (const endpoint of STAFF_ENDPOINTS.slice(0, 12)) {
      const response = await callEndpoint(anonymous, endpoint);
      expect(response.status).toBe(401);
    }
  });
});

describe('سلسله‌مراتب ساخت حساب کارکنان', () => {
  it('هیچ نقشی نمی‌تواند حساب هم‌سطح یا بالاتر بسازد', async () => {
    const studentAffairs = await createStaff(db, { username: 'h.sa', role: 'StudentAffairs' });
    const nutrition = await createStaff(db, { username: 'h.nm', role: 'NutritionManager' });
    const finance = await createStaff(db, { username: 'h.fin', role: 'Finance' });
    const superAdmin = await createStaff(db, { username: 'h.sa2', role: 'SuperAdmin' });

    const saClient = await loginStaff(ctx.app, studentAffairs.username, studentAffairs.password);
    // معاونت دانشجویی مجوز `users`/`operators` ندارد ⇒ ساخت هیچ حساب کارکنانی را ندارد
    const saCreatesOperator = await saClient.post('/api/v1/staff', {
      username: 'x.op',
      fullName: 'اپراتور',
      role: 'Operator',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(saCreatesOperator.status).toBe(403);

    const nmClient = await loginStaff(ctx.app, nutrition.username, nutrition.password);
    const nmCreatesHigher = await nmClient.post('/api/v1/staff', {
      username: 'x.sa',
      fullName: 'معاونت',
      role: 'StudentAffairs',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(nmCreatesHigher.status).toBe(403);

    const nmCreatesSuper = await nmClient.post('/api/v1/staff', {
      username: 'x.root',
      fullName: 'مدیر ارشد',
      role: 'SuperAdmin',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(nmCreatesSuper.status).toBe(403);

    const finClient = await loginStaff(ctx.app, finance.username, finance.password);
    const finCreatesOperator = await finClient.post('/api/v1/staff', {
      username: 'x.op2',
      fullName: 'اپراتور',
      role: 'Operator',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(finCreatesOperator.status).toBe(403);

    const adminClient = await loginStaff(ctx.app, superAdmin.username, superAdmin.password);
    const adminCreatesSuper = await adminClient.post('/api/v1/staff', {
      username: 'x.root2',
      fullName: 'مدیر ارشد دوم',
      role: 'SuperAdmin',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(adminCreatesSuper.status).toBe(403);
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

  it('معاونت دانشجویی فقط حساب کارمند (مشتری سلف) می‌سازد، نه کارکنان', async () => {
    const studentAffairs = await createStaff(db, { username: 'e.sa', role: 'StudentAffairs' });
    const client = await loginStaff(ctx.app, studentAffairs.username, studentAffairs.password);

    const employee = await client.post('/api/v1/employees', {
      username: 'e.emp',
      fullName: 'کارمند دانشگاه',
      customerGroup: 'Employee',
      status: 'Active',
    });
    expect(employee.status).toBe(200);
    expect((employee.body as { temporaryPassword?: string }).temporaryPassword).toBeTruthy();

    const staff = await client.post('/api/v1/staff', {
      username: 'e.op',
      fullName: 'اپراتور',
      role: 'Operator',
      status: 'Active',
      password: 'a-strong-password-1',
    });
    expect(staff.status).toBe(403);
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
    const settingsByFinance = await financeClient.get('/api/v1/settings');
    expect(settingsByFinance.status).toBe(403);
    const auditByFinance = await financeClient.get('/api/v1/audit');
    expect(auditByFinance.status).toBe(403);
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
