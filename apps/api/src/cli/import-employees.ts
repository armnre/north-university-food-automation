import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { normalizeDigits } from '@food/shared';
import { createDb, createPool } from '../db/client.js';
import { hashPassword } from '../lib/password.js';

/**
 * Imports staff / faculty from the university Excel files.
 *   node dist/cli/import-employees.js <file.xlsx> [Staff|Faculty]
 * Username = شماره پرسنلی (staff) or شماره کارگزینی (faculty); password = کد ملی (no forced change).
 * Existing usernames are updated (names, kind, password); nobody is deleted.
 */
const [file, kindArg] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !file) {
  console.error('usage: DATABASE_URL=... node dist/cli/import-employees.js <file.xlsx> [Staff|Faculty]');
  process.exit(2);
}
const norm = (h: string) => h.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim();
const cellText = (v: ExcelJS.CellValue) => normalizeDigits(String(v && typeof v === 'object' && 'text' in v ? v.text : (v ?? ''))).trim();

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
type Row = { username: string; firstName: string; lastName: string; nationalId: string };
let rows: Row[] = [];
let kind = kindArg === 'Staff' || kindArg === 'Faculty' ? kindArg : '';
for (const ws of wb.worksheets) {
  let cols: Record<string, number> | null = null;
  const out: Row[] = [];
  ws.eachRow((r) => {
    const vals = (r.values as ExcelJS.CellValue[]).map(cellText);
    if (!cols) {
      const m: Record<string, number> = {};
      vals.forEach((v, i) => {
        const h = norm(v);
        if (h === 'شماره پرسنلی' || h === 'شماره کارگزینی') { m.u = i; kind ||= h === 'شماره پرسنلی' ? 'Staff' : 'Faculty'; }
        else if (h === 'نام') m.f = i;
        else if (h === 'نام خانوادگی') m.l = i;
        else if (h === 'شماره ملی' || h === 'کد ملی') m.n = i;
      });
      if (m.u != null && m.f != null && m.l != null && m.n != null) cols = m;
      return;
    }
    const u = vals[cols.u!]!.replace(/\D/g, '');
    const n = vals[cols.n!]!.replace(/\D/g, '');
    if (!u || !n) return;
    out.push({ username: u, firstName: vals[cols.f!]!, lastName: vals[cols.l!]!, nationalId: n.padStart(10, '0') });
  });
  if (cols) { rows = out; break; }
}
if (!rows.length || !kind) {
  console.error('No sheet with شماره پرسنلی/کارگزینی, نام, نام خانوادگی, شماره/کد ملی columns found.');
  process.exit(1);
}

const pool = createPool(url, 1);
const db = createDb(pool);
let created = 0;
let updated = 0;
await db.transaction(async (tx) => {
  for (const r of rows) {
    const hash = await hashPassword(r.nationalId);
    const ex = await tx.execute<{ id: string }>(sql`SELECT id FROM employees WHERE lower(username)=${r.username}`);
    if (ex.rows[0]) {
      await tx.execute(sql`UPDATE employees SET first_name=${r.firstName}, last_name=${r.lastName}, kind=${kind}::employee_kind, personnel_code=${r.username},
        password_hash=${hash}, must_change_password=false, active=true, updated_at=now() WHERE id=${ex.rows[0].id}`);
      updated++;
    } else {
      const ins = await tx.execute<{ id: string }>(sql`INSERT INTO employees (username, first_name, last_name, kind, personnel_code, password_hash, must_change_password)
        VALUES (${r.username}, ${r.firstName}, ${r.lastName}, ${kind}::employee_kind, ${r.username}, ${hash}, false) RETURNING id`);
      await tx.execute(sql`INSERT INTO accounts (kind, employee_id) VALUES ('Customer', ${ins.rows[0]!.id})`);
      created++;
    }
  }
  await tx.execute(sql`INSERT INTO audit_logs (actor, action, entity_type, data) VALUES ('cli', 'employee.import-excel', 'Employee', ${JSON.stringify({ kind, created, updated })}::jsonb)`);
});
console.log(`${kind}: ${created} created, ${updated} updated`);
await pool.end();
