import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { isValidNationalId, maskNationalId, normalizeDigits, normalizeName } from '@food/shared';
import { accounts, importBatches, importRows, students } from '../db/schema/index.js';
import { hmacSha256Hex, sha256Hex } from '../lib/crypto.js';
import { AppError, fail } from '../lib/errors.js';
import type { Actor, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { ensureStudentAccount } from './account.service.js';
import { revokeAllSessionsForSubject } from './session.service.js';
import { rawSql } from '../db/raw.js';

/**
 * واردسازی اکسل دانشجویان.
 *
 *  - پارس سمت **سرور** با `exceljs`، فقط `.xlsx`، حداکثر ۵ مگابایت و ۱۰٬۰۰۰ ردیف، بدون ماکرو.
 *  - پیش‌نمایش بدون نوشتن در `students`؛ ثبت نهایی در **یک تراکنش** (همه یا هیچ).
 *  - تعارض کد ملی فقط با تأیید صریح معاونت روی همان ردیف اعمال می‌شود.
 *  - `fullSync`: دانشجوی غایب فقط به `Removed` می‌رود (غیرفعال، نه حذف) + ابطال نشست‌ها.
 *  - کد ملی خام هیچ‌جا ذخیره/برگردانده نمی‌شود (فقط HMAC + ۴ رقم آخر).
 *  - فایل خام نگهداری نمی‌شود.
 */

export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type ParsedRow = {
  rowNumber: number;
  studentNumber: string;
  fullName: string;
  nationalId: string;
  faculty: string;
  major: string;
  degree: string;
  entryYear: string;
};

const COLUMN_ALIASES: Record<string, string[]> = {
  studentNumber: ['شماره دانشجویی', 'شماره دانشجوئی', 'شماره‌دانشجویی', 'studentnumber', 'student_number', 'student no', 'شماره'],
  fullName: ['نام و نام خانوادگی', 'نام', 'نام کامل', 'fullname', 'full_name', 'name'],
  nationalId: ['کد ملی', 'کدملی', 'nationalid', 'national_id', 'nationalcode', 'کدملی'],
  faculty: ['دانشکده', 'faculty', 'دانشکده/پردیس'],
  major: ['رشته', 'major', 'رشته تحصیلی', 'field'],
  degree: ['مقطع', 'degree', 'مقطع تحصیلی', 'level'],
  entryYear: ['سال ورود', 'entryyear', 'entry_year', 'ورود'],
};

function normalizeHeaderCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\u200c/g, '')
    .replace(/[\s.:/\\_-]+/g, '')
    .toLowerCase()
    .trim();
}

function matchColumn(header: string): keyof ParsedRow | null {
  const normalized = normalizeHeaderCell(header);
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.some((alias) => normalizeHeaderCell(alias) === normalized)) return field as keyof ParsedRow;
  }
  return null;
}

/** پارس فایل xlsx در سمت سرور. */
export async function parseStudentWorkbook(buffer: Buffer, fileName: string, sheetName?: string): Promise<ParsedRow[]> {
  const name = String(fileName ?? '').toLowerCase();
  if (!name.endsWith('.xlsx')) {
    throw new AppError('VALIDATION', 'فقط فایل‌های xlsx پذیرفته می‌شوند (فایل‌های xls و csv مجاز نیستند).');
  }
  if (name.endsWith('.xlsm') || buffer.includes(Buffer.from('vbaProject.bin'))) {
    throw new AppError('VALIDATION', 'فایل‌های دارای ماکرو پذیرفته نمی‌شوند.');
  }
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new AppError('VALIDATION', `حجم فایل نباید بیشتر از ${MAX_IMPORT_BYTES / (1024 * 1024)} مگابایت باشد.`);
  }
  if (buffer.length < 4 || buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new AppError('VALIDATION', 'فایل ارسالی یک فایل xlsx معتبر نیست.');
  }

  const workbook = new ExcelJS.Workbook();
  // exceljs هم Buffer و هم ArrayBuffer می‌پذیرد؛ برای سازگاری با باندل‌های مختلف
  // یک ArrayBuffer از روی همان حافظه می‌سازیم (بدون کپی اضافه).
  const asArrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(asArrayBuffer);
  const worksheet = (sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]) ?? null;
  if (!worksheet) throw new AppError('VALIDATION', 'هیچ شیتی در فایل یافت نشد.');

  const headerRowIndex = findHeaderRow(worksheet);
  if (headerRowIndex === null) {
    throw new AppError('VALIDATION', 'ردیف سرستون یافت نشد. فایل باید شامل ستون‌های «شماره دانشجویی»، «نام» و «کد ملی» باشد.');
  }
  const columnMap = buildColumnMap(worksheet, headerRowIndex);
  if (!columnMap.studentNumber || !columnMap.nationalId) {
    throw new AppError('VALIDATION', 'ستون‌های «شماره دانشجویی» و «کد ملی» در فایل یافت نشد.');
  }

  const rows: ParsedRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowIndex) return;
    if (rows.length >= MAX_IMPORT_ROWS) return;
    const read = (field: keyof ParsedRow): string => {
      const col = columnMap[field];
      if (!col) return '';
      return cellToString(row.getCell(col).value);
    };
    const parsed: ParsedRow = {
      rowNumber,
      studentNumber: read('studentNumber'),
      fullName: read('fullName'),
      nationalId: read('nationalId'),
      faculty: read('faculty'),
      major: read('major'),
      degree: read('degree'),
      entryYear: read('entryYear'),
    };
    const isEmpty = !parsed.studentNumber && !parsed.fullName && !parsed.nationalId;
    if (isEmpty) return;
    rows.push(parsed);
  });

  if (rows.length === 0) throw new AppError('VALIDATION', 'فایل هیچ ردیف داده‌ای ندارد.');
  if (worksheet.rowCount > MAX_IMPORT_ROWS + headerRowIndex) {
    throw new AppError('VALIDATION', `حداکثر ${MAX_IMPORT_ROWS} ردیف در هر بار واردسازی مجاز است.`);
  }
  return rows;
}

function findHeaderRow(worksheet: ExcelJS.Worksheet): number | null {
  for (let i = 1; i <= Math.min(10, worksheet.rowCount); i += 1) {
    const row = worksheet.getRow(i);
    let matched = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (matchColumn(cellToString(cell.value))) matched += 1;
    });
    if (matched >= 2) return i;
  }
  return null;
}

function buildColumnMap(worksheet: ExcelJS.Worksheet, headerRowIndex: number): Partial<Record<keyof ParsedRow, number>> {
  const map: Partial<Record<keyof ParsedRow, number>> = {};
  const row = worksheet.getRow(headerRowIndex);
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const field = matchColumn(cellToString(cell.value));
    if (field && !map[field]) map[field] = colNumber;
  });
  return map;
}

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const rich = value as { richText?: { text: string }[]; text?: string | { text?: string }; result?: unknown };
    if (Array.isArray(rich.richText)) return rich.richText.map((t) => t.text).join('');
    if (typeof rich.text === 'string') return rich.text;
    if (rich.text && typeof rich.text === 'object') return String(rich.text.text ?? '');
    if (rich.result != null) return String(rich.result);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return '';
  }
  return String(value).trim();
}

/** محافظ CSV/formula injection برای مقادیری که در گزارش‌ها نمایش داده می‌شوند. */
function cleanText(value: string): string {
  return normalizeName(
    String(value ?? '')
      .replace(/[<>]/g, '')
      .replace(/^[=+\-@]+/, ''),
  ).slice(0, 200);
}

export type PreviewRow = {
  rowNumber: number;
  studentNumber: string;
  fullName: string;
  faculty: string;
  major: string;
  degree: string;
  entryYear: number | null;
  nationalIdHash: string;
  nationalIdLast4: string;
  kind: 'new' | 'changed' | 'unchanged' | 'returning' | 'conflict' | 'error';
  errors: string[];
  changes: string[];
  studentId: string | null;
};

/** پیش‌نمایش: اعتبارسنجی، مقایسه با دادهٔ موجود و مرحله‌سازی (بدون نوشتن در students). */
export async function previewImport(
  deps: ServiceDeps,
  input: {
    buffer: Buffer;
    fileName: string;
    policy: 'RejectAllOnError' | 'SkipInvalidRows';
    fullSync: boolean;
    sheet?: string;
    actor: Actor;
    staffId: string;
    ip: string;
  },
) {
  const rawRows = await parseStudentWorkbook(input.buffer, input.fileName, input.sheet);

  const parsed: PreviewRow[] = rawRows.map((row) => {
    const studentNumber = normalizeDigits(row.studentNumber);
    const nationalId = normalizeDigits(row.nationalId);
    const year = normalizeDigits(row.entryYear);
    const errors: string[] = [];

    if (!studentNumber) errors.push('شمارهٔ دانشجویی خالی است');
    else if (!/^\d{5,15}$/.test(studentNumber)) errors.push('قالب شمارهٔ دانشجویی نامعتبر است (۵ تا ۱۵ رقم)');
    const fullName = cleanText(row.fullName);
    if (!fullName) errors.push('نام و نام خانوادگی خالی است');
    const nationalIdValid = isValidNationalId(nationalId);
    if (!nationalId) errors.push('کد ملی خالی است');
    else if (!nationalIdValid) errors.push('کد ملی نامعتبر است (رقم کنترلی صحیح نیست)');
    if (year && !/^\d{2,4}$/.test(year)) errors.push('سال ورود نامعتبر است');

    return {
      rowNumber: row.rowNumber,
      studentNumber,
      fullName,
      faculty: cleanText(row.faculty),
      major: cleanText(row.major),
      degree: cleanText(row.degree),
      entryYear: year ? Number(year) : null,
      nationalIdHash: nationalIdValid ? hmacSha256Hex(deps.env.NATIONAL_ID_PEPPER, nationalId) : '',
      nationalIdLast4: nationalIdValid ? nationalId.slice(-4) : '',
      kind: errors.length ? 'error' : 'new',
      errors,
      changes: [],
      studentId: null,
    };
  });

  // تکراری‌های داخل فایل
  const snCount = new Map<string, number>();
  const nidCount = new Map<string, number>();
  for (const row of parsed) {
    if (row.studentNumber) snCount.set(row.studentNumber, (snCount.get(row.studentNumber) ?? 0) + 1);
    if (row.nationalIdHash) nidCount.set(row.nationalIdHash, (nidCount.get(row.nationalIdHash) ?? 0) + 1);
  }
  for (const row of parsed) {
    if ((snCount.get(row.studentNumber) ?? 0) > 1) row.errors.push('شمارهٔ دانشجویی تکراری در فایل');
    if (row.nationalIdHash && (nidCount.get(row.nationalIdHash) ?? 0) > 1) row.errors.push('کد ملی تکراری در فایل');
    if (row.errors.length) row.kind = 'error';
  }

  // مقایسه با دانشجویان موجود
  const studentNumbers = [...snCount.keys()];
  const hashes = [...nidCount.keys()];
  const existing = studentNumbers.length
    ? await deps.db.execute(
        rawSql(
          `SELECT id, student_number AS "studentNumber", full_name AS "fullName", faculty, major, degree, entry_year AS "entryYear",
                  national_id_hash AS "nationalIdHash", status
           FROM students WHERE student_number = ANY($1::text[]) OR national_id_hash = ANY($2::text[])`,
          [studentNumbers, hashes],
        ),
      )
    : { rows: [] };
  const existingRows = (((existing as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map(
    (row) => ({
      id: String(row.id),
      studentNumber: String(row.studentNumber ?? ''),
      fullName: String(row.fullName ?? ''),
      faculty: String(row.faculty ?? ''),
      major: String(row.major ?? ''),
      degree: String(row.degree ?? ''),
      entryYear: row.entryYear == null ? null : Number(row.entryYear),
      nationalIdHash: String(row.nationalIdHash ?? ''),
      status: String(row.status ?? 'Active'),
    }),
  );
  const byNumber = new Map(existingRows.map((row) => [row.studentNumber, row]));
  const byHash = new Map(existingRows.filter((row) => row.nationalIdHash).map((row) => [row.nationalIdHash, row]));

  for (const row of parsed) {
    if (row.kind === 'error') continue;
    const ownerByHash = row.nationalIdHash ? byHash.get(row.nationalIdHash) : undefined;
    if (ownerByHash && ownerByHash.studentNumber !== row.studentNumber) {
      row.errors.push('این کد ملی متعلق به شمارهٔ دانشجویی دیگری است');
      row.kind = 'error';
      continue;
    }
    const existingStudent = byNumber.get(row.studentNumber);
    if (!existingStudent) {
      row.kind = 'new';
      continue;
    }
    row.studentId = existingStudent.id;
    if (existingStudent.nationalIdHash && existingStudent.nationalIdHash !== row.nationalIdHash) {
      // تعارض کد ملی: چون کد ملی همان اعتبار ورود است، فقط با تأیید صریح معاونت اعمال می‌شود
      row.kind = 'conflict';
      row.changes.push('کد ملی');
      continue;
    }
    const diff: string[] = [];
    if (existingStudent.fullName !== row.fullName) diff.push('نام');
    if (existingStudent.faculty !== row.faculty) diff.push('دانشکده');
    if (existingStudent.major !== row.major) diff.push('رشته');
    if (existingStudent.degree !== row.degree) diff.push('مقطع');
    if (existingStudent.entryYear !== row.entryYear) diff.push('سال ورود');
    row.kind = existingStudent.status === 'Removed' ? 'returning' : diff.length ? 'changed' : 'unchanged';
    row.changes = diff;
  }

  // دانشجویان غایب در فایل (فقط در حالت fullSync)
  const missing = input.fullSync
    ? (
        (
          (await deps.db.execute(
            rawSql(
              `SELECT id, student_number AS "studentNumber", full_name AS "fullName", faculty, status
             FROM students WHERE deleted_at IS NULL AND status <> 'Removed' AND NOT (student_number = ANY($1::text[]))
             ORDER BY student_number`,
              [studentNumbers],
            ),
          )) as unknown as { rows: Record<string, unknown>[] }
        ).rows ?? []
      ).map((row) => ({
        id: String(row.id),
        studentNumber: String(row.studentNumber ?? ''),
        fullName: String(row.fullName ?? ''),
        faculty: String(row.faculty ?? ''),
        status: String(row.status ?? ''),
      }))
    : [];

  const activeCount = Number(
    ((
      (await deps.db.execute(
        rawSql(`SELECT COUNT(*)::int AS n FROM students WHERE deleted_at IS NULL AND status <> 'Removed'`),
      )) as unknown as { rows: { n: number }[] }
    ).rows ?? [])[0]?.n ?? 0,
  );

  const summary = {
    total: parsed.length,
    valid: parsed.filter((r) => r.kind !== 'error').length,
    errors: parsed.filter((r) => r.kind === 'error').length,
    new: parsed.filter((r) => r.kind === 'new').length,
    changed: parsed.filter((r) => r.kind === 'changed').length,
    unchanged: parsed.filter((r) => r.kind === 'unchanged').length,
    returning: parsed.filter((r) => r.kind === 'returning').length,
    conflicts: parsed.filter((r) => r.kind === 'conflict').length,
    removed: missing.length,
  };

  const fingerprint = sha256Hex(
    JSON.stringify(parsed.map((r) => [r.studentNumber, r.nationalIdHash, r.fullName, r.faculty, r.major, r.degree, r.entryYear])),
  );
  const duplicate = await deps.db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(sql`${importBatches.fileFingerprint} = ${fingerprint} AND ${importBatches.status} = 'Committed'`)
    .limit(1);

  const batch = await deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(importBatches)
      .values({
        fileName: String(input.fileName).slice(0, 200),
        uploadedBy: input.staffId,
        status: 'Preview',
        policy: input.policy,
        fullSync: input.fullSync,
        totalRows: summary.total,
        validRows: summary.valid,
        errorRows: summary.errors,
        newRows: summary.new,
        changedRows: summary.changed,
        unchangedRows: summary.unchanged,
        returningRows: summary.returning,
        removedRows: summary.removed,
        conflictRows: summary.conflicts,
        fileFingerprint: fingerprint,
        errorReport: parsed
          .filter((r) => r.kind === 'error')
          .slice(0, 5000)
          .map((r) => ({ rowNumber: r.rowNumber, studentNumber: r.studentNumber, errors: r.errors })),
      })
      .returning({ id: importBatches.id });

    // ذخیرهٔ ردیف‌های مرحله‌شده (فقط دادهٔ هش‌شده/غیرحساس؛ کد ملی خام nowhere)
    const chunkSize = 500;
    for (let i = 0; i < parsed.length; i += chunkSize) {
      await tx.insert(importRows).values(
        parsed.slice(i, i + chunkSize).map((row) => ({
          batchId: created!.id,
          rowNumber: row.rowNumber,
          studentNumber: row.studentNumber,
          fullName: row.fullName,
          faculty: row.faculty,
          major: row.major,
          degree: row.degree,
          entryYear: row.entryYear,
          nationalIdHash: row.nationalIdHash,
          nationalIdLast4: row.nationalIdLast4,
          kind: row.kind,
          studentId: row.studentId,
          errors: row.errors,
          changes: row.changes,
        })),
      );
    }

    await writeAudit(tx, {
      actor: input.actor,
      action: 'import.preview',
      targetType: 'ImportBatch',
      targetId: created!.id,
      details: { fileName: input.fileName, ...summary },
      ip: input.ip,
    });
    return created!.id;
  });

  return {
    batchId: batch,
    fileName: String(input.fileName),
    summary,
    duplicateOfCommitted: duplicate.length > 0,
    blocked: input.policy === 'RejectAllOnError' && summary.errors > 0,
    massRemovalWarning: activeCount > 20 && missing.length > activeCount * 0.3,
    rows: parsed.slice(0, 1000).map((row) => ({
      rowNumber: row.rowNumber,
      studentNumber: row.studentNumber,
      fullName: row.fullName,
      faculty: row.faculty,
      major: row.major,
      degree: row.degree,
      entryYear: row.entryYear,
      nationalIdMasked: maskNationalId(row.nationalIdLast4),
      kind: row.kind,
      errors: row.errors,
      changes: row.changes,
    })),
    errorReport: parsed
      .filter((r) => r.kind === 'error')
      .slice(0, 2000)
      .map((r) => ({ rowNumber: r.rowNumber, studentNumber: r.studentNumber, errors: r.errors })),
    conflicts: parsed
      .filter((r) => r.kind === 'conflict')
      .map((r) => ({ rowNumber: r.rowNumber, studentNumber: r.studentNumber, fullName: r.fullName })),
    removed: missing.slice(0, 2000),
  };
}

export type CommitResult = {
  batchId: string;
  status: string;
  written: number;
  created: number;
  updated: number;
  removed: number;
  conflictsSkipped: number;
  sessionsRevoked: number;
  replay: boolean;
};

/**
 * ثبت نهایی در **یک تراکنش** (همه یا هیچ) با قفل ردیف batch تا دو تأیید
 * هم‌زمان اجرا نشود.
 */
export async function commitImport(
  deps: ServiceDeps,
  input: { batchId: string; approvedConflicts?: number[]; actor: Actor; staffId: string; ip: string },
): Promise<CommitResult> {
  return deps.db.transaction(async (tx) => {
    const locked = await tx.execute(rawSql(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`, [input.batchId]));
    const batch = ((locked as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
    if (!batch) fail('NOT_FOUND', 'دستهٔ واردسازی یافت نشد.');

    const status = String(batch.status);
    if (status === 'Committed') {
      return {
        batchId: input.batchId,
        status: 'Committed',
        written: Number(batch.new_rows ?? 0) + Number(batch.changed_rows ?? 0),
        created: Number(batch.new_rows ?? 0),
        updated: Number(batch.changed_rows ?? 0),
        removed: Number(batch.removed_rows ?? 0),
        conflictsSkipped: 0,
        sessionsRevoked: 0,
        replay: true,
      };
    }
    if (status !== 'Preview' && status !== 'Failed') fail('CONFLICT', 'این دسته قابل ثبت نیست.');
    if (String(batch.policy) === 'RejectAllOnError' && Number(batch.error_rows ?? 0) > 0) {
      fail('CONFLICT', 'طبق سیاست انتخاب‌شده، به دلیل وجود ردیف‌های خطادار، واردسازی انجام نمی‌شود.');
    }

    const approved = new Set((input.approvedConflicts ?? []).map((n) => Number(n)));
    const rowsResult = await tx.execute(rawSql(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [input.batchId]));
    const rows = (((rowsResult as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      rowNumber: Number(row.row_number),
      studentNumber: String(row.student_number ?? ''),
      fullName: String(row.full_name ?? ''),
      faculty: String(row.faculty ?? ''),
      major: String(row.major ?? ''),
      degree: String(row.degree ?? ''),
      entryYear: row.entry_year == null ? null : Number(row.entry_year),
      nationalIdHash: String(row.national_id_hash ?? ''),
      nationalIdLast4: String(row.national_id_last4 ?? ''),
      kind: String(row.kind ?? 'new'),
    }));

    let created = 0;
    let updated = 0;
    let conflictsSkipped = 0;
    let sessionsRevoked = 0;

    for (const row of rows) {
      if (row.kind === 'error' || row.kind === 'unchanged') continue;
      if (row.kind === 'conflict' && !approved.has(row.rowNumber)) {
        conflictsSkipped += 1;
        continue;
      }

      const existingRows = await tx
        .select()
        .from(students)
        .where(sql`${students.studentNumber} = ${row.studentNumber}`)
        .limit(1);
      const existing = existingRows[0];

      if (!existing) {
        const [inserted] = await tx
          .insert(students)
          .values({
            studentNumber: row.studentNumber,
            fullName: row.fullName,
            faculty: row.faculty,
            major: row.major,
            degree: row.degree,
            entryYear: row.entryYear,
            nationalIdHash: row.nationalIdHash,
            nationalIdLast4: row.nationalIdLast4,
            status: 'Active',
            addedAt: new Date(),
            lastImportBatchId: input.batchId,
          })
          .onConflictDoUpdate({
            target: students.studentNumber,
            set: {
              fullName: row.fullName,
              faculty: row.faculty,
              major: row.major,
              degree: row.degree,
              entryYear: row.entryYear,
              nationalIdHash: row.nationalIdHash,
              nationalIdLast4: row.nationalIdLast4,
              status: 'Active',
              removedAt: null,
              lastImportBatchId: input.batchId,
            },
          })
          .returning({ id: students.id });
        await ensureStudentAccount(tx, inserted!.id);
        created += 1;
      } else {
        await tx
          .update(students)
          .set({
            fullName: row.fullName,
            faculty: row.faculty,
            major: row.major,
            degree: row.degree,
            entryYear: row.entryYear,
            nationalIdHash: row.nationalIdHash,
            nationalIdLast4: row.nationalIdLast4,
            // ورودسازی هرگز یک دانشجو را بی‌صدا فعال مجدد نمی‌کند، مگر اینکه Removed بوده باشد
            status: existing.status === 'Removed' ? 'Active' : existing.status,
            removedAt: existing.status === 'Removed' ? null : existing.removedAt,
            lastImportBatchId: input.batchId,
          })
          .where(sql`${students.id} = ${existing.id}`);
        await ensureStudentAccount(tx, existing.id);
        updated += 1;
      }
    }

    // fullSync: دانشجویان غایب فقط Removed (غیرفعال) می‌شوند + ابطال نشست‌ها
    let removed = 0;
    if (batch.full_sync) {
      const studentNumbers = rows.filter((r) => r.kind !== 'error').map((r) => r.studentNumber);
      const missingResult = await tx.execute(
        rawSql(`SELECT id FROM students WHERE deleted_at IS NULL AND status <> 'Removed' AND NOT (student_number = ANY($1::text[]))`, [
          studentNumbers,
        ]),
      );
      const missingIds = (((missingResult as unknown as { rows: { id: string }[] }).rows ?? []) as { id: string }[]).map((r) => r.id);
      for (const id of missingIds) {
        await tx
          .update(students)
          .set({ status: 'Removed', removedAt: new Date(), lastImportBatchId: input.batchId })
          .where(sql`${students.id} = ${id}`);
        await tx
          .update(accounts)
          .set({ isActive: false })
          .where(sql`${accounts.studentId} = ${id}`);
        sessionsRevoked += await revokeAllSessionsForSubject(tx, 'Student', id, 'removed_by_full_sync');
        removed += 1;
      }
    }

    await tx
      .update(importBatches)
      .set({
        status: 'Committed',
        committedAt: new Date(),
        committedBy: input.staffId,
        newRows: created,
        changedRows: updated,
        removedRows: removed,
        conflictRows: conflictsSkipped,
      })
      .where(sql`${importBatches.id} = ${input.batchId}`);

    await tx
      .update(importRows)
      .set({ applied: true })
      .where(sql`${importRows.batchId} = ${input.batchId} AND ${importRows.kind} <> 'error'`);

    await writeAudit(tx, {
      actor: input.actor,
      action: 'import.commit',
      targetType: 'ImportBatch',
      targetId: input.batchId,
      details: { created, updated, removed, conflictsSkipped, sessionsRevoked, approvedConflicts: [...approved] },
      ip: input.ip,
    });

    return {
      batchId: input.batchId,
      status: 'Committed',
      written: created + updated,
      created,
      updated,
      removed,
      conflictsSkipped,
      sessionsRevoked,
      replay: false,
    };
  });
}

/** لغو یک دستهٔ پیش‌نمایش. */
export async function cancelImport(deps: ServiceDeps, input: { batchId: string; actor: Actor; ip: string }): Promise<{ ok: true }> {
  await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(importBatches)
      .where(sql`${importBatches.id} = ${input.batchId}`)
      .limit(1);
    const batch = rows[0];
    if (!batch) fail('NOT_FOUND', 'دسته یافت نشد.');
    if (batch.status !== 'Preview') fail('CONFLICT', 'فقط دسته‌های در حال پیش‌نمایش قابل لغو هستند.');
    await tx
      .update(importBatches)
      .set({ status: 'Cancelled' })
      .where(sql`${importBatches.id} = ${input.batchId}`);
    await writeAudit(tx, { actor: input.actor, action: 'import.cancel', targetType: 'ImportBatch', targetId: input.batchId, ip: input.ip });
  });
  return { ok: true };
}

/** فهرست دسته‌های واردسازی. */
export async function listImportBatches(deps: ServiceDeps) {
  const rows = await deps.db.execute(
    rawSql(`SELECT b.id, b.file_name AS "fileName", b.status, b.policy, b.full_sync AS "fullSync", b.total_rows AS "totalRows",
              b.valid_rows AS "validRows", b.error_rows AS "errorRows", b.new_rows AS "newRows", b.changed_rows AS "changedRows",
              b.removed_rows AS "removedRows", b.conflict_rows AS "conflictRows", b.created_at AS "createdAt", b.committed_at AS "committedAt",
              b.undone_at AS "undoneAt", u.full_name AS "uploadedBy"
             FROM import_batches b LEFT JOIN staff_users u ON u.id = b.uploaded_by
             ORDER BY b.created_at DESC LIMIT 100`),
  );
  const list = (((rows as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    fileName: String(row.fileName ?? ''),
    status: String(row.status ?? ''),
    policy: String(row.policy ?? ''),
    fullSync: Boolean(row.fullSync),
    totalRows: Number(row.totalRows ?? 0),
    validRows: Number(row.validRows ?? 0),
    errorRows: Number(row.errorRows ?? 0),
    newRows: Number(row.newRows ?? 0),
    changedRows: Number(row.changedRows ?? 0),
    removedRows: Number(row.removedRows ?? 0),
    conflictRows: Number(row.conflictRows ?? 0),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    committedAt: row.committedAt ? new Date(String(row.committedAt)).toISOString() : null,
    uploadedBy: row.uploadedBy == null ? null : String(row.uploadedBy),
    canUndo: String(row.status) === 'Committed' && !row.undoneAt,
  }));
  return { batches: list };
}

/**
 * بازگردانی (Undo) آخرین دسته: فقط ردیف‌های **جدیدِ بدون هیچ فعالیت**
 * (رزرو، ورود، تراکنش مالی). حذف فیزیکی انجام نمی‌شود ⇒ وضعیت `Removed`.
 */
export async function undoImport(deps: ServiceDeps, input: { batchId: string; actor: Actor; staffId: string; ip: string }) {
  return deps.db.transaction(async (tx) => {
    const locked = await tx.execute(rawSql(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`, [input.batchId]));
    const batch = ((locked as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
    if (!batch) fail('NOT_FOUND', 'دسته یافت نشد.');
    if (String(batch.status) !== 'Committed') fail('CONFLICT', 'فقط دستهٔ ثبت‌شده قابل بازگردانی است.');
    if (batch.undone_at) fail('CONFLICT', 'این دسته قبلاً بازگردانی شده است.');

    const latest = await tx.execute(
      rawSql(`SELECT id FROM import_batches WHERE status = 'Committed' ORDER BY committed_at DESC NULLS LAST, created_at DESC LIMIT 1`),
    );
    const latestId = String(((latest as unknown as { rows: { id: string }[] }).rows ?? [])[0]?.id ?? '');
    if (latestId && latestId !== input.batchId) {
      return { batchId: input.batchId, undone: 0, blocked: 1, reason: 'فقط آخرین دستهٔ ثبت‌شده قابل بازگردانی است.' };
    }

    const rowsResult = await tx.execute(
      rawSql(`SELECT student_number, kind FROM import_rows WHERE batch_id = $1 AND kind IN ('new','returning')`, [input.batchId]),
    );
    const candidates = (
      ((rowsResult as unknown as { rows: { student_number: string; kind: string }[] }).rows ?? []) as {
        student_number: string;
        kind: string;
      }[]
    ).map((r) => r.student_number);
    if (candidates.length === 0) {
      await tx
        .update(importBatches)
        .set({ status: 'Undone', undoneAt: new Date(), undoneBy: input.staffId })
        .where(sql`${importBatches.id} = ${input.batchId}`);
      return { batchId: input.batchId, undone: 0, blocked: 0, reason: 'ردیف جدیدی برای بازگردانی وجود نداشت.' };
    }

    const activity = await tx.execute(
      rawSql(
        `SELECT s.student_number AS sn,
                EXISTS(SELECT 1 FROM accounts a JOIN reservations r ON r.account_id = a.id WHERE a.student_id = s.id) AS has_reservation,
                EXISTS(SELECT 1 FROM accounts a JOIN ledger_entries e ON e.account_id = a.id WHERE a.student_id = s.id) AS has_ledger,
                (s.last_login_at IS NOT NULL) AS has_login
         FROM students s WHERE s.student_number = ANY($1::text[])`,
        [candidates],
      ),
    );
    let undone = 0;
    let blocked = 0;
    for (const row of ((activity as unknown as { rows: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]) {
      if (row.has_reservation || row.has_ledger || row.has_login) {
        blocked += 1;
        continue;
      }
      const studentNumber = String(row.sn);
      const studentRows = await tx
        .select({ id: students.id })
        .from(students)
        .where(sql`${students.studentNumber} = ${studentNumber}`)
        .limit(1);
      const studentId = studentRows[0]?.id;
      if (!studentId) continue;
      await tx
        .update(students)
        .set({ status: 'Removed', removedAt: new Date() })
        .where(sql`${students.id} = ${studentId}`);
      await tx
        .update(accounts)
        .set({ isActive: false })
        .where(sql`${accounts.studentId} = ${studentId}`);
      await revokeAllSessionsForSubject(tx, 'Student', studentId, 'import_undo');
      undone += 1;
    }

    await tx
      .update(importBatches)
      .set({ status: 'Undone', undoneAt: new Date(), undoneBy: input.staffId })
      .where(sql`${importBatches.id} = ${input.batchId}`);
    await writeAudit(tx, {
      actor: input.actor,
      action: 'import.undo',
      targetType: 'ImportBatch',
      targetId: input.batchId,
      details: { undone, blocked },
      ip: input.ip,
    });
    return {
      batchId: input.batchId,
      undone,
      blocked,
      reason: blocked > 0 ? 'برخی ردیف‌ها به دلیل داشتن فعالیت قابل بازگردانی نیستند.' : null,
    };
  });
}

/** پاک‌سازی ردیف‌های مرحله‌شده پس از ۷ روز (job `cleanup`). */
export async function cleanupImportRows(deps: ServiceDeps, olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await deps.db.delete(importRows).where(sql`${importRows.createdAt} < ${cutoff}`);
  return Number((result as { rowCount?: number }).rowCount ?? 0);
}
