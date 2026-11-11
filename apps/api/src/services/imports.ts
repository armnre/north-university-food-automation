import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { isValidNationalId, nationalIdLast4, normalizeDigits, normalizeNationalId } from '@food/shared';
import type { Db } from '../db/client.js';
import { hmac } from '../lib/crypto.js';
import { fail } from '../lib/errors.js';

export const MAX_ROWS = 10_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export type FieldKey = 'studentNumber' | 'nationalId' | 'fullName' | 'firstName' | 'lastName' | 'faculty' | 'major' | 'degree' | 'entryYear' | 'mobile';
const GUESS: Record<FieldKey, string[]> = {
  studentNumber: ['شماره دانشجویی', 'شماره دانشجو', 'student', 'stno'],
  nationalId: ['کد ملی', 'کدملی', 'national'],
  fullName: ['نام و نام خانوادگی', 'نام کامل', 'fullname'],
  firstName: ['نام', 'first'],
  lastName: ['نام خانوادگی', 'فامیلی', 'last'],
  faculty: ['دانشکده', 'faculty'],
  major: ['رشته', 'major'],
  degree: ['مقطع', 'degree'],
  entryYear: ['سال ورود', 'ورودی', 'entry'],
  mobile: ['موبایل', 'تلفن همراه', 'mobile'],
};

export function guessMapping(headers: string[]): Partial<Record<FieldKey, string>> {
  const m: Partial<Record<FieldKey, string>> = {};
  const used = new Set<string>();
  for (const k of Object.keys(GUESS) as FieldKey[]) {
    const h = headers.find((x) => !used.has(x) && GUESS[k].some((g) => x.trim().toLowerCase() === g.toLowerCase()));
    if (h) {
      m[k] = h;
      used.add(h);
    }
  }
  for (const k of Object.keys(GUESS) as FieldKey[]) {
    if (m[k]) continue;
    const h = headers.find((x) => !used.has(x) && GUESS[k].some((g) => x.toLowerCase().includes(g.toLowerCase())));
    if (h) {
      m[k] = h;
      used.add(h);
    }
  }
  return m;
}

/** Parses an .xlsx buffer (first sheet, header row 1). Rejects non-xlsx by magic bytes (PK zip). */
export async function parseXlsx(buf: Buffer) {
  if (buf.length > MAX_BYTES) fail('BAD_REQUEST', 'حجم فایل بیش از ۵ مگابایت است.');
  if (buf.subarray(0, 4).toString('hex') !== '504b0304') fail('BAD_REQUEST', 'فقط فایل اکسل ‎.xlsx‎ پذیرفته می‌شود.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    fail('BAD_REQUEST', 'فایل اکسل قابل خواندن نیست.');
  }
  const ws = wb.worksheets[0];
  if (!ws) fail('BAD_REQUEST', 'فایل اکسل خالی است.');
  const cell = (v: ExcelJS.CellValue): string => {
    if (v == null) return '';
    if (typeof v === 'object' && 'text' in v) return String(v.text ?? '');
    if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
    if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('');
    return String(v);
  };
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as ExcelJS.CellValue[]).slice(1).map((c) => cell(c).trim()));
  });
  if (rows.length < 2) fail('BAD_REQUEST', 'فایل باید ردیف عنوان و حداقل یک ردیف داده داشته باشد.');
  if (rows.length - 1 > MAX_ROWS) fail('BAD_REQUEST', `حداکثر ${MAX_ROWS} ردیف مجاز است.`);
  const headers = rows[0]!.map((h, i) => h || `ستون ${i + 1}`);
  return { headers, data: rows.slice(1) };
}

type Payload = {
  studentNumber: string;
  nidHash: string;
  last4: string;
  firstName: string;
  lastName: string;
  faculty: string | null;
  major: string | null;
  degree: string | null;
  entryYear: number | null;
  mobile: string | null;
};
export type PreviewRow = {
  rowNumber: number;
  studentNumber: string;
  fullName: string;
  faculty: string;
  major: string;
  kind: 'NEW' | 'UPDATE' | 'UNCHANGED' | 'CONFLICT' | 'ERROR';
  errors: string[];
  changes: string[];
  payload?: Payload;
};

export async function buildPreview(db: Db, pepper: string, headers: string[], data: string[][], mapping: Partial<Record<FieldKey, string>>) {
  const idx = (k: FieldKey) => (mapping[k] ? headers.indexOf(mapping[k]!) : -1);
  if (idx('studentNumber') < 0 || idx('nationalId') < 0 || (idx('fullName') < 0 && idx('firstName') < 0 && idx('lastName') < 0))
    fail('BAD_REQUEST', 'ستون‌های شماره دانشجویی، کد ملی و نام الزامی‌اند.');
  const get = (r: string[], k: FieldKey) => (idx(k) >= 0 ? (r[idx(k)] ?? '').trim() : '');
  const existing = new Map<
    string,
    {
      national_id_hash: string;
      first_name: string;
      last_name: string;
      faculty: string | null;
      major: string | null;
      degree: string | null;
      entry_year: number | null;
      status: string;
    }
  >();
  const ex = await db.execute<{
    student_number: string;
    national_id_hash: string;
    first_name: string;
    last_name: string;
    faculty: string | null;
    major: string | null;
    degree: string | null;
    entry_year: number | null;
    status: string;
  }>(sql`SELECT student_number, national_id_hash, first_name, last_name, faculty, major, degree, entry_year, status FROM students WHERE deleted_at IS NULL`);
  for (const r of ex.rows) existing.set(r.student_number, r);
  const seenSn = new Map<string, number>();
  const seenNid = new Map<string, number>();
  const rows: PreviewRow[] = data.map((r, i) => {
    const rowNumber = i + 2;
    const errors: string[] = [];
    const sn = normalizeDigits(get(r, 'studentNumber'));
    const nid = normalizeNationalId(get(r, 'nationalId'));
    let first = get(r, 'firstName');
    let last = get(r, 'lastName');
    if (!first && !last) {
      const parts = get(r, 'fullName').split(/\s+/);
      first = parts.shift() ?? '';
      last = parts.join(' ');
    }
    if (!/^\d{5,20}$/.test(sn)) errors.push('شماره دانشجویی نامعتبر است');
    if (!isValidNationalId(nid)) errors.push('کد ملی نامعتبر است');
    if (!first && !last) errors.push('نام خالی است');
    if (sn && seenSn.has(sn)) errors.push(`شماره دانشجویی تکراری (ردیف ${seenSn.get(sn)})`);
    const nidHash = hmac(pepper, `nid:${nid}`);
    if (nid && seenNid.has(nidHash)) errors.push(`کد ملی تکراری (ردیف ${seenNid.get(nidHash)})`);
    seenSn.set(sn, rowNumber);
    seenNid.set(nidHash, rowNumber);
    const yr = normalizeDigits(get(r, 'entryYear'));
    const payload: Payload = {
      studentNumber: sn,
      nidHash,
      last4: nationalIdLast4(nid),
      firstName: first || '-',
      lastName: last || '-',
      faculty: get(r, 'faculty') || null,
      major: get(r, 'major') || null,
      degree: get(r, 'degree') || null,
      entryYear: /^\d{2,4}$/.test(yr) ? Number(yr) : null,
      mobile: normalizeDigits(get(r, 'mobile')) || null,
    };
    const base = {
      rowNumber,
      studentNumber: sn,
      fullName: `${first} ${last}`.trim(),
      faculty: payload.faculty ?? '',
      major: payload.major ?? '',
      errors,
      changes: [] as string[],
    };
    if (errors.length) return { ...base, kind: 'ERROR' as const };
    const cur = existing.get(sn);
    if (!cur) return { ...base, kind: 'NEW' as const, payload };
    if (cur.national_id_hash !== nidHash) return { ...base, kind: 'CONFLICT' as const, payload, changes: ['کد ملی با سابقه‌ی موجود متفاوت است'] };
    const changes: string[] = [];
    if (cur.first_name !== payload.firstName || cur.last_name !== payload.lastName) changes.push('نام');
    if ((cur.faculty ?? null) !== payload.faculty) changes.push('دانشکده');
    if ((cur.major ?? null) !== payload.major) changes.push('رشته');
    if ((cur.degree ?? null) !== payload.degree) changes.push('مقطع');
    if (cur.status !== 'Active') changes.push('وضعیت ← فعال');
    return { ...base, kind: changes.length ? ('UPDATE' as const) : ('UNCHANGED' as const), changes, payload };
  });
  const inFile = new Set(rows.map((r) => r.studentNumber));
  const removed = ex.rows.filter((r) => r.status === 'Active' && !inFile.has(r.student_number)).map((r) => r.student_number);
  return { rows, removed, activeCount: ex.rows.filter((r) => r.status === 'Active').length };
}

export const csvSafe = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
