import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { Client, testApp } from '../helpers/app.js';
import { credit, makeOffering, makeStaff, makeStudent, nationalId, STAFF_PASSWORD, uniq } from '../helpers/factory.js';

let t: Awaited<ReturnType<typeof testApp>>;
let affairs: Client;
let nutrition: Client;
let finance: Client;
beforeAll(async () => {
  t = await testApp();
  const login = async (role: 'StudentAffairs' | 'NutritionManager' | 'Finance', ip: string) => {
    const u = await makeStaff(t.db, role);
    const c = new Client(t.app, ip);
    await c.req('POST', '/api/v1/auth/staff/login', { username: u.username, password: STAFF_PASSWORD });
    return c;
  };
  affairs = await login('StudentAffairs', '10.40.0.1');
  nutrition = await login('NutritionManager', '10.40.0.2');
  finance = await login('Finance', '10.40.0.3');
});
afterAll(async () => {
  await t.close();
});

async function xlsx(rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['شماره دانشجویی', 'کد ملی', 'نام', 'نام خانوادگی', 'دانشکده']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('excel import', () => {
  it('rejects non-xlsx content even with .xlsx name', async () => {
    const r = await affairs.upload('/api/v1/imports/preview', { name: 'x.xlsx', data: Buffer.from('a,b\n1,2') });
    expect(r.status).toBe(400);
  });

  it('preview → commit creates students; raw national id is never stored; concurrent commits commit once', async () => {
    const nids = [nationalId(), nationalId()];
    const sns = [`9${uniq()}`, `9${uniq()}`];
    const pv = await affairs.upload(
      '/api/v1/imports/preview',
      {
        name: 'a.xlsx',
        data: await xlsx([
          [sns[0]!, nids[0]!, 'رضا', 'کریمی', 'فنی'],
          [sns[1]!, nids[1]!, 'مینا', 'نوری', 'علوم'],
          ['abc', '123', '', '', ''],
        ]),
      },
      { policy: 'SkipInvalidRows' },
    );
    expect(pv.status).toBe(200);
    expect(pv.body.summary).toMatchObject({ NEW: 2, ERROR: 1 });
    expect(pv.body.errorCsv).toContain('کد ملی نامعتبر');
    const [a, b] = await Promise.all([
      affairs.req('POST', `/api/v1/imports/${pv.body.batchId}/commit`),
      affairs.req('POST', `/api/v1/imports/${pv.body.batchId}/commit`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const dump =
      JSON.stringify((await t.db.execute(sql`SELECT * FROM students WHERE student_number = ANY(${`{${sns.join(',')}}`}::text[])`)).rows) +
      JSON.stringify((await t.db.execute(sql`SELECT payload FROM import_rows WHERE batch_id=${pv.body.batchId}`)).rows) +
      JSON.stringify((await t.db.execute(sql`SELECT data FROM audit_logs WHERE entity_id=${pv.body.batchId}`)).rows);
    for (const nid of nids) expect(dump).not.toContain(nid);
    // undo the last batch: both new students have no activity → removed
    const u = await affairs.req('POST', `/api/v1/imports/${pv.body.batchId}/undo`);
    expect(u.body.removed).toBe(2);
  });

  it('national-id conflict is skipped unless explicitly approved per row, approval revokes sessions', async () => {
    const s = await makeStudent(t.db);
    const pv = await affairs.upload('/api/v1/imports/preview', { name: 'c.xlsx', data: await xlsx([[s.sn, nationalId(), 'سارا', 'احمدی', '']]) });
    expect(pv.body.summary.CONFLICT).toBe(1);
    expect((await affairs.req('POST', `/api/v1/imports/${pv.body.batchId}/approve-conflict`, { rowNumber: 2, reason: 'اصلاح کد ملی طبق مدارک' })).status).toBe(
      200,
    );
    const c = await affairs.req('POST', `/api/v1/imports/${pv.body.batchId}/commit`);
    expect(c.body.conflicts).toBe(1);
    // the student can no longer log in with the old national id
    const old = await new Client(t.app, '10.41.0.1').req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
    expect(old.status).toBe(401);
  });

  it('undo refuses a batch that is not the latest', async () => {
    const list = await affairs.req('GET', '/api/v1/imports');
    const older = list.body.batches.find((b: { status: string }) => b.status === 'Undone');
    expect((await affairs.req('POST', `/api/v1/imports/${older.id}/undo`)).status).toBe(409);
  });
});

describe('reports', () => {
  it('summary + export (csv/xlsx) with injection-safe cells and no national ids', async () => {
    const s = await makeStudent(t.db);
    await credit(t.db, s.account.id, 500_000n);
    const o = await makeOffering(t.db);
    const sc = new Client(t.app, '10.42.0.1');
    await sc.req('POST', '/api/v1/auth/student/login', { studentNumber: s.sn, nationalId: s.nid });
    expect((await sc.req('POST', '/api/v1/me/reserve', { offeringId: o, idempotencyKey: `k-${uniq()}` })).status).toBe(200);
    await t.db.execute(sql`UPDATE foods SET name='=HYPERLINK("x")' WHERE id=(SELECT food_id FROM meal_offerings WHERE id=${o})`);
    const d = (await t.db.execute<{ d: string }>(sql`SELECT service_date::text d FROM meal_offerings WHERE id=${o}`)).rows[0]!.d;
    const sum = await nutrition.req('GET', `/api/v1/reports/summary?from=${d}&to=${d}`);
    expect(sum.body.totals.reserved).toBeGreaterThanOrEqual(1);
    const csv = await nutrition.raw(`/api/v1/reports/export?from=${d}&to=${d}&format=csv`);
    const text = csv.body.toString('utf8');
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toContain(s.nid);
    const x = await nutrition.raw(`/api/v1/reports/export?from=${d}&to=${d}&format=xlsx`);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const adv = await finance.req('GET', `/api/v1/reports/advanced?from=${d}&to=${d}`);
    expect(adv.body.systemAccounts.length).toBe(4);
    const advN = await nutrition.req('GET', `/api/v1/reports/advanced?from=${d}&to=${d}`);
    expect(advN.body.systemAccounts).toBeUndefined();
    const prof = await sc.req('GET', '/api/v1/me/profile');
    expect(prof.body.balanceRial).toBe(400_000);
    expect(JSON.stringify(prof.body)).not.toContain(s.nid);
  });
});

describe('food image upload', () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f6c8a50000000049454e44ae426082',
    'hex',
  );
  it('accepts a real PNG (re-encoded), rejects disguised files, serves it back', async () => {
    const r = await nutrition.upload('/api/v1/uploads/food-image', { name: 'a.png', data: png, type: 'image/png' });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^\/uploads\/foods\/[0-9a-f-]{36}\.(webp|png)$/);
    expect((await nutrition.raw(r.body.url)).status).toBe(200);
    const bad = await nutrition.upload('/api/v1/uploads/food-image', { name: 'a.png', data: Buffer.from('<svg onload=alert(1)>'), type: 'image/png' });
    expect(bad.status).toBe(400);
    expect((await finance.upload('/api/v1/uploads/food-image', { name: 'a.png', data: png })).status).toBe(403);
    expect((await nutrition.raw('/uploads/foods/..%2F..%2Fetc%2Fpasswd')).status).not.toBe(200);
  });
});
