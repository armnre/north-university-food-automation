import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { getTestDb, query, resetDatabase } from '../helpers/db.js';
import { buildTestApp, createTestClient, loginStaff, primeCsrf, type TestApp, type TestClient } from '../helpers/app.js';
import { createStaff, createStudent, makeNationalId, resetBaseCache, seedBase } from '../helpers/fixtures.js';

/**
 * واردسازی اکسل دانشجویان (مرحلهٔ ۳):
 * پارس سمت سرور، پیش‌نمایش، سیاست خطا، تعارض کد ملی، fullSync، لغو، Undo،
 * دو تأیید هم‌زمان و نبودِ کد ملی خام در هر خروجی/ذخیره‌ای.
 */

const db = getTestDb();
let ctx: TestApp;
let admin: { username: string; password: string };
let client: TestClient;

type Row = {
  studentNumber: string;
  fullName: string;
  nationalId: string;
  faculty?: string;
  major?: string;
  degree?: string;
  entryYear?: string;
};

async function buildXlsx(rows: Row[], headers?: string[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  sheet.addRow(headers ?? ['شماره دانشجویی', 'نام و نام خانوادگی', 'کد ملی', 'دانشکده', 'رشته', 'مقطع', 'سال ورود']);
  for (const row of rows) {
    sheet.addRow([
      row.studentNumber,
      row.fullName,
      row.nationalId,
      row.faculty ?? '',
      row.major ?? '',
      row.degree ?? '',
      row.entryYear ?? '',
    ]);
  }
  const written = await workbook.xlsx.writeBuffer();
  // exceljs در باندل ESM ممکن است ArrayBuffer برگرداند؛ همیشه Buffer می‌سازیم
  return Buffer.from(written instanceof ArrayBuffer ? new Uint8Array(written) : (written as unknown as Uint8Array));
}

async function upload(buffer: Buffer, options: { policy?: string; fullSync?: boolean; name?: string } = {}) {
  return client.upload(
    '/api/v1/imports/preview',
    { name: options.name ?? 'students.xlsx', buffer },
    { policy: options.policy ?? 'SkipInvalidRows', fullSync: String(options.fullSync ?? false) },
  );
}

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
  const staff = await createStaff(db, { username: 'import.admin', role: 'SuperAdmin' });
  admin = { username: staff.username, password: staff.password };
  client = await loginStaff(ctx.app, admin.username, admin.password);
});

afterAll(async () => {
  await ctx?.close();
});

type Preview = {
  batchId: string;
  summary: {
    total: number;
    valid: number;
    errors: number;
    new: number;
    changed: number;
    unchanged: number;
    returning: number;
    conflicts: number;
    removed: number;
  };
  blocked: boolean;
  duplicateOfCommitted: boolean;
  massRemovalWarning: boolean;
  rows: { rowNumber: number; studentNumber: string; kind: string; errors: string[]; changes: string[]; nationalIdMasked: string }[];
  errorReport: { rowNumber: number; studentNumber: string; errors: string[] }[];
  conflicts: { rowNumber: number; studentNumber: string; fullName: string }[];
  removed: { id: string; studentNumber: string; fullName: string }[];
};

describe('واردسازی اکسل', () => {
  it('فایل معتبر: پیش‌نمایش بدون نوشتن، ثبت نهایی در یک تراکنش', async () => {
    const rows: Row[] = [
      {
        studentNumber: '400100001',
        fullName: 'دانشجوی یک',
        nationalId: makeNationalId(101),
        faculty: 'فنی',
        major: 'کامپیوتر',
        degree: 'کارشناسی',
        entryYear: '1402',
      },
      {
        studentNumber: '400100002',
        fullName: 'دانشجوی دو',
        nationalId: makeNationalId(102),
        faculty: 'علوم',
        major: 'ریاضی',
        degree: 'کارشناسی',
        entryYear: '1401',
      },
    ];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    expect(preview.summary.total).toBe(2);
    expect(preview.summary.new).toBe(2);
    expect(preview.summary.errors).toBe(0);
    expect(preview.blocked).toBe(false);

    // پیش از ثبت، هیچ دانشجویی ساخته نشده است
    const beforeCommit = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    expect(beforeCommit[0]?.n).toBe(0);

    const commit = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect(commit.status).toBe(200);
    const result = commit.body as { written: number; created: number; status: string; replay: boolean };
    expect(result.created).toBe(2);
    expect(result.status).toBe('Committed');

    const afterCommit = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    expect(afterCommit[0]?.n).toBe(2);
    const accountsCount = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM accounts`);
    expect(accountsCount[0]?.n).toBe(2);

    // ثبت دوبارهٔ همان دسته ⇒ replay بدون اثر دوم
    const again = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect((again.body as { replay: boolean }).replay).toBe(true);
    const stillTwo = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    expect(stillTwo[0]?.n).toBe(2);
  });

  it('کد ملی نامعتبر و شمارهٔ کوتاه ⇒ ردیف خطا و گزارش', async () => {
    const rows: Row[] = [
      { studentNumber: '400200001', fullName: 'دانشجوی یک', nationalId: makeNationalId(201) },
      { studentNumber: '400200002', fullName: 'دانشجوی دو', nationalId: makeNationalId(202) },
      { studentNumber: '400200003', fullName: 'کد ملی خراب', nationalId: '1111111111' },
      { studentNumber: '12', fullName: 'شماره کوتاه', nationalId: makeNationalId(204) },
    ];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    expect(preview.summary.errors).toBe(2);
    expect(preview.summary.valid).toBe(2);
    expect(preview.errorReport.map((r) => r.rowNumber).sort()).toEqual([4, 5]);
    expect(preview.errorReport.flatMap((r) => r.errors).join(' ')).toContain('کد ملی');

    // با سیاست «رد کردن همه» ثبت ممکن نیست
    const strict = (await upload(await buildXlsx(rows), { policy: 'RejectAllOnError' })).body as Preview;
    expect(strict.blocked).toBe(true);
    const blockedCommit = await client.post(`/api/v1/imports/${strict.batchId}/commit`, {});
    expect(blockedCommit.status).toBe(409);

    // با سیاست «رد کردن ردیف‌های خطادار» فقط ردیف‌های سالم ثبت می‌شوند
    const commit = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect((commit.body as { created: number }).created).toBe(2);
  });

  it('شمارهٔ دانشجویی تکراری داخل فایل ⇒ هر دو ردیف خطا می‌گیرند', async () => {
    const rows: Row[] = [
      { studentNumber: '400210001', fullName: 'دانشجوی یک', nationalId: makeNationalId(211) },
      { studentNumber: '400210001', fullName: 'نسخهٔ تکراری', nationalId: makeNationalId(212) },
    ];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    expect(preview.summary.errors).toBe(2);
    expect(preview.summary.valid).toBe(0);
    expect(preview.errorReport.flatMap((r) => r.errors).join(' ')).toContain('تکراری');
    const commit = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect((commit.body as { created: number }).created).toBe(0);
  });

  it('کد ملی تکراری برای دو شمارهٔ دانشجویی متفاوت ⇒ خطا', async () => {
    const sameNationalId = makeNationalId(221);
    const rows: Row[] = [
      { studentNumber: '400220001', fullName: 'یک', nationalId: sameNationalId },
      { studentNumber: '400220002', fullName: 'دو', nationalId: sameNationalId },
    ];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    expect(preview.summary.errors).toBe(2);
    expect(preview.errorReport.flatMap((r) => r.errors).join(' ')).toContain('کد ملی تکراری');
  });

  it('تعارض کد ملی فقط با تأیید صریح معاونت اعمال می‌شود', async () => {
    const existing = await createStudent(db, { studentNumber: '400300001', nationalId: makeNationalId(301) });
    const rows: Row[] = [{ studentNumber: '400300001', fullName: 'نام به‌روز', nationalId: makeNationalId(999) }];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;

    expect(preview.summary.conflicts).toBe(1);
    expect(preview.rows[0]?.kind).toBe('conflict');

    // بدون تأیید ⇒ ردیف اعمال نمی‌شود
    const withoutApproval = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect((withoutApproval.body as { conflictsSkipped: number }).conflictsSkipped).toBe(1);
    const unchanged = await query<{ national_id_hash: string }>(db, `SELECT national_id_hash FROM students WHERE id = $1`, [
      existing.studentId,
    ]);
    expect(unchanged[0]?.national_id_hash).toBe(existing.nationalIdHash);

    // با تأیید صریح ردیف ⇒ کد ملی به‌روز می‌شود و در ممیزی ثبت می‌گردد
    const rows2: Row[] = [{ studentNumber: '400300001', fullName: 'نام به‌روز', nationalId: makeNationalId(999) }];
    const preview2 = (await upload(await buildXlsx(rows2))).body as Preview;
    const approved = await client.post(`/api/v1/imports/${preview2.batchId}/commit`, { approvedConflicts: [2] });
    expect((approved.body as { updated: number }).updated).toBe(1);
    const changed = await query<{ national_id_hash: string; full_name: string }>(
      db,
      `SELECT national_id_hash, full_name FROM students WHERE id = $1`,
      [existing.studentId],
    );
    expect(changed[0]?.national_id_hash).not.toBe(existing.nationalIdHash);
    expect(changed[0]?.full_name).toBe('نام به‌روز');

    const audit = await query<{ details: unknown }>(
      db,
      `SELECT details FROM audit_logs WHERE action = 'import.commit' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(JSON.stringify(audit[0]?.details)).toContain('approvedConflicts');
  });

  it('fullSync: دانشجوی غایب فقط Removed می‌شود و نشست‌هایش باطل می‌گردد', async () => {
    const keep = await createStudent(db, { studentNumber: '400400001', nationalId: makeNationalId(401) });
    const drop = await createStudent(db, { studentNumber: '400400002', nationalId: makeNationalId(402) });

    // نشست فعال برای دانشجوی غایب
    const dropClient = createTestClient(ctx.app);
    await primeCsrf(dropClient);
    const login = await dropClient.post('/api/v1/auth/student/login', { studentNumber: drop.studentNumber, nationalId: drop.nationalId });
    expect(login.status).toBe(200);

    const rows: Row[] = [{ studentNumber: '400400001', fullName: 'دانشجوی باقی', nationalId: makeNationalId(401) }];
    const preview = (await upload(await buildXlsx(rows), { fullSync: true })).body as Preview;
    expect(preview.summary.removed).toBe(1);
    expect(preview.removed[0]?.studentNumber).toBe('400400002');

    const commit = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect((commit.body as { removed: number }).removed).toBe(1);
    expect((commit.body as { sessionsRevoked: number }).sessionsRevoked).toBe(1);

    const statuses = await query<{ student_number: string; status: string }>(
      db,
      `SELECT student_number, status FROM students ORDER BY student_number`,
    );
    expect(statuses.find((r) => r.student_number === '400400002')?.status).toBe('Removed');
    expect(statuses.find((r) => r.student_number === '400400001')?.status).toBe('Active');
    // حذف فیزیکی نشده است
    expect(statuses).toHaveLength(2);

    // نشست دانشجو باطل شده
    const afterLogin = await dropClient.get('/api/v1/auth/me');
    expect(afterLogin.status).toBe(401);
    void keep;
  });

  it('هشدار حذف انبوه وقتی بیش از ۳۰٪ فهرست در فایل نیستند', async () => {
    for (let i = 0; i < 30; i += 1) {
      await createStudent(db, { studentNumber: String(400500000 + i), nationalId: makeNationalId(500 + i) });
    }
    const rows: Row[] = [{ studentNumber: '400500000', fullName: 'تنها ردیف', nationalId: makeNationalId(500) }];
    const preview = (await upload(await buildXlsx(rows), { fullSync: true })).body as Preview;
    expect(preview.massRemovalWarning).toBe(true);
    expect(preview.summary.removed).toBe(29);
  });

  it('لغو دستهٔ پیش‌نمایش', async () => {
    const rows: Row[] = [{ studentNumber: '400600001', fullName: 'دانشجو', nationalId: makeNationalId(601) }];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    const cancel = await client.post(`/api/v1/imports/${preview.batchId}/cancel`);
    expect(cancel.status).toBe(200);
    const commit = await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    expect(commit.status).toBe(409);
    const count = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    expect(count[0]?.n).toBe(0);
  });

  it('دو تأیید هم‌زمان ⇒ فقط یکی ثبت می‌کند (قفل ردیف دسته)', async () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      studentNumber: String(400700000 + i),
      fullName: `دانشجوی ${i}`,
      nationalId: makeNationalId(700 + i),
    }));
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    const client2 = await loginStaff(ctx.app, admin.username, admin.password);

    const [first, second] = await Promise.all([
      client.post(`/api/v1/imports/${preview.batchId}/commit`, {}),
      client2.post(`/api/v1/imports/${preview.batchId}/commit`, {}),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 200]);
    const replays = [first, second].filter((r) => (r.body as { replay?: boolean }).replay === true).length;
    expect(replays).toBe(1);

    const count = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM students`);
    expect(count[0]?.n).toBe(20);
    const accounts = await query<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM accounts`);
    expect(accounts[0]?.n).toBe(20);
  });

  it('بازگردانی (Undo) آخرین دسته: فقط ردیف‌های جدید بدون فعالیت', async () => {
    const rows: Row[] = [
      { studentNumber: '400800001', fullName: 'بدون فعالیت', nationalId: makeNationalId(801) },
      { studentNumber: '400800002', fullName: 'با ورود', nationalId: makeNationalId(802) },
    ];
    const preview = (await upload(await buildXlsx(rows))).body as Preview;
    await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});

    // یکی از دانشجویان ورود می‌کند ⇒ فعالیت دارد
    const active = createTestClient(ctx.app);
    await primeCsrf(active);
    const login = await active.post('/api/v1/auth/student/login', { studentNumber: '400800002', nationalId: makeNationalId(802) });
    expect(login.status).toBe(200);

    const undo = await client.post(`/api/v1/imports/${preview.batchId}/undo`);
    expect(undo.status).toBe(200);
    const body = undo.body as { undone: number; blocked: number; reason: string | null };
    expect(body.undone).toBe(1);
    expect(body.blocked).toBe(1);

    const statuses = await query<{ student_number: string; status: string }>(
      db,
      `SELECT student_number, status FROM students ORDER BY student_number`,
    );
    expect(statuses.find((r) => r.student_number === '400800001')?.status).toBe('Removed');
    expect(statuses.find((r) => r.student_number === '400800002')?.status).toBe('Active');

    // Undo دوباره ممکن نیست
    const again = await client.post(`/api/v1/imports/${preview.batchId}/undo`);
    expect(again.status).toBe(409);
  });

  it('فقط آخرین دسته قابل بازگردانی است', async () => {
    const first = (await upload(await buildXlsx([{ studentNumber: '400900001', fullName: 'یک', nationalId: makeNationalId(901) }])))
      .body as Preview;
    await client.post(`/api/v1/imports/${first.batchId}/commit`, {});
    const second = (await upload(await buildXlsx([{ studentNumber: '400900002', fullName: 'دو', nationalId: makeNationalId(902) }])))
      .body as Preview;
    await client.post(`/api/v1/imports/${second.batchId}/commit`, {});

    const undoOld = await client.post(`/api/v1/imports/${first.batchId}/undo`);
    expect(undoOld.status).toBe(200);
    expect((undoOld.body as { undone: number; reason: string | null }).undone).toBe(0);
    expect((undoOld.body as { reason: string | null }).reason).toContain('آخرین دسته');
  });

  it('فایل غیر xlsx، دارای ماکرو یا بزرگ‌تر از ۵ مگابایت رد می‌شود', async () => {
    const csv = Buffer.from('studentNumber,fullName\n400000001,test\n', 'utf8');
    const csvResponse = await client.upload(
      '/api/v1/imports/preview',
      { name: 'students.csv', buffer: csv },
      { policy: 'SkipInvalidRows', fullSync: 'false' },
    );
    expect(csvResponse.status).toBe(400);

    const macro = Buffer.concat([
      await buildXlsx([{ studentNumber: '400000001', fullName: 'تست', nationalId: makeNationalId(1) }]),
      Buffer.from('vbaProject.bin'),
    ]);
    const macroResponse = await client.upload(
      '/api/v1/imports/preview',
      { name: 'students.xlsx', buffer: macro },
      { policy: 'SkipInvalidRows', fullSync: 'false' },
    );
    expect([400, 413]).toContain(macroResponse.status);

    const big = Buffer.alloc(6 * 1024 * 1024, 65);
    const bigResponse = await client.upload(
      '/api/v1/imports/preview',
      { name: 'big.xlsx', buffer: big },
      { policy: 'SkipInvalidRows', fullSync: 'false' },
    );
    expect([400, 413]).toContain(bigResponse.status);
  });

  it('فایل بدون ستون‌های لازم یا خالی رد می‌شود', async () => {
    const noColumns = await buildXlsx(
      [{ studentNumber: '400000001', fullName: 'تست', nationalId: makeNationalId(1) }],
      ['ستون الف', 'ستون ب'],
    );
    const response = await upload(noColumns);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('شماره دانشجویی');
  });

  it('کد ملی خام هیچ‌جا ذخیره یا برگردانده نمی‌شود', async () => {
    const nationalId = makeNationalId(1234);
    const rows: Row[] = [{ studentNumber: '401000001', fullName: 'دانشجوی محرمانه', nationalId }];
    const previewResponse = await upload(await buildXlsx(rows));
    const preview = previewResponse.body as Preview;
    expect(previewResponse.raw).not.toContain(nationalId);
    expect(preview.rows[0]?.nationalIdMasked).toBe(`••••••${nationalId.slice(-4)}`);

    await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});

    // در دیتابیس: نه در students، نه در import_rows
    const stored = await query<Record<string, unknown>>(db, `SELECT * FROM students`);
    expect(JSON.stringify(stored)).not.toContain(nationalId);
    const staged = await query<Record<string, unknown>>(db, `SELECT * FROM import_rows`);
    expect(JSON.stringify(staged)).not.toContain(nationalId);
    const audit = await query<Record<string, unknown>>(db, `SELECT * FROM audit_logs`);
    expect(JSON.stringify(audit)).not.toContain(nationalId);

    const list = await client.get('/api/v1/admin/students');
    expect(list.raw).not.toContain(nationalId);
    const batches = await client.get('/api/v1/imports');
    expect(batches.raw).not.toContain(nationalId);
  });

  it('فهرست دسته‌ها و امکان Undo در آن دیده می‌شود', async () => {
    const preview = (await upload(await buildXlsx([{ studentNumber: '401100001', fullName: 'یک', nationalId: makeNationalId(1101) }])))
      .body as Preview;
    await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    const list = await client.get<{ batches: { id: string; status: string; canUndo: boolean; uploadedBy: string | null }[] }>(
      '/api/v1/imports',
    );
    expect(list.status).toBe(200);
    const batch = (list.body as { batches: { id: string; status: string; canUndo: boolean }[] }).batches[0];
    expect(batch?.status).toBe('Committed');
    expect(batch?.canUndo).toBe(true);
  });

  it('واردسازی دانشجوی بازگشتی (Removed) او را فعال می‌کند', async () => {
    const removed = await createStudent(db, { studentNumber: '401200001', nationalId: makeNationalId(1201), status: 'Removed' });
    const preview = (await upload(await buildXlsx([{ studentNumber: '401200001', fullName: 'بازگشتی', nationalId: makeNationalId(1201) }])))
      .body as Preview;
    expect(preview.summary.returning).toBe(1);
    await client.post(`/api/v1/imports/${preview.batchId}/commit`, {});
    const rows = await query<{ status: string }>(db, `SELECT status FROM students WHERE id = $1`, [removed.studentId]);
    expect(rows[0]?.status).toBe('Active');
  });
});
