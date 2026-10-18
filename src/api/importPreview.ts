import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, hashNationalId, isValidNationalId, normalizeDigits, requireStaff, sha256, staffActor } from '../server/core';

const MAX_ROWS = 3000;
const rowSchema = z.object({
  rowNumber: z.number().int(),
  studentNumber: z.string().max(40).optional().default(''),
  fullName: z.string().max(200).optional().default(''),
  nationalId: z.string().max(40).optional().default(''),
  faculty: z.string().max(200).optional().default(''),
  major: z.string().max(200).optional().default(''),
  degree: z.string().max(100).optional().default(''),
  entryYear: z.string().max(10).optional().default(''),
});

const clean = (s: string) => String(s ?? '').replace(/[<>]/g, '').replace(/^[=+\-@]+/, '').trim();

export default createEndpoint({
  description: 'Validates uploaded student rows, stages them, and returns a preview (nothing is written to Students)',
  inputSchema: z.object({ token: z.string(), fileName: z.string().max(200), policy: z.enum(['RejectAllOnError', 'SkipInvalidRows']), rows: z.array(rowSchema).max(MAX_ROWS) }),
  outputSchema: z.any(),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'import');
    if (!input.rows.length) fail('BAD_REQUEST', 'فایل هیچ ردیف داده‌ای ندارد.');
    if (input.rows.length > MAX_ROWS) fail('BAD_REQUEST', `حداکثر ${MAX_ROWS} ردیف در هر بار واردسازی مجاز است.`);

    const parsed = await Promise.all(input.rows.map(async (r) => {
      const sn = normalizeDigits(r.studentNumber);
      const nid = normalizeDigits(r.nationalId);
      const year = normalizeDigits(r.entryYear);
      const errors: string[] = [];
      if (!sn) errors.push('شماره دانشجویی خالی است');
      else if (!/^\d{5,15}$/.test(sn)) errors.push('قالب شماره دانشجویی نامعتبر است');
      if (!clean(r.fullName)) errors.push('نام خالی است');
      if (!nid) errors.push('کد ملی خالی است');
      else if (!isValidNationalId(nid)) errors.push('کد ملی نامعتبر است');
      if (year && !/^\d{2,4}$/.test(year)) errors.push('سال ورود نامعتبر است');
      return {
        rowNumber: r.rowNumber, studentNumber: sn, fullName: clean(r.fullName), faculty: clean(r.faculty), major: clean(r.major), degree: clean(r.degree),
        entryYear: year ? Number(year) : null, nationalIdHash: nid && isValidNationalId(nid) ? await hashNationalId(nid) : '', nationalIdLastDigits: nid.slice(-4),
        errors, kind: 'new' as 'new' | 'changed' | 'unchanged' | 'error', changes: [] as string[],
      };
    }));

    // duplicates inside the file
    const snCount = new Map<string, number>(); const nidCount = new Map<string, number>();
    parsed.forEach((p) => { if (p.studentNumber) snCount.set(p.studentNumber, (snCount.get(p.studentNumber) ?? 0) + 1); if (p.nationalIdHash) nidCount.set(p.nationalIdHash, (nidCount.get(p.nationalIdHash) ?? 0) + 1); });
    parsed.forEach((p) => {
      if ((snCount.get(p.studentNumber) ?? 0) > 1) p.errors.push('شماره دانشجویی تکراری در فایل');
      if ((nidCount.get(p.nationalIdHash) ?? 0) > 1) p.errors.push('کد ملی تکراری در فایل');
    });

    // compare with existing students
    const sns = [...snCount.keys()];
    const hashes = [...nidCount.keys()];
    const existing = sns.length ? (await zite.sql({ query: `SELECT id, "studentNumber", "fullName", "faculty", "major", "degree", "entryYear", "nationalIdHash" FROM "Students" WHERE "studentNumber" = ANY($1::text[]) OR "nationalIdHash" = ANY($2::text[])`, params: [sns, hashes] })).rows : [];
    const bySn = new Map(existing.map((e) => [String(e.studentNumber), e]));
    const byHash = new Map(existing.map((e) => [String(e.nationalIdHash), e]));
    for (const p of parsed) {
      const owner = p.nationalIdHash ? byHash.get(p.nationalIdHash) : undefined;
      if (owner && String(owner.studentNumber) !== p.studentNumber) p.errors.push('این کد ملی متعلق به شماره دانشجویی دیگری است');
      if (p.errors.length) { p.kind = 'error'; continue; }
      const e = bySn.get(p.studentNumber);
      if (!e) continue;
      const diff: string[] = [];
      if ((e.fullName ?? '') !== p.fullName) diff.push('نام');
      if ((e.faculty ?? '') !== p.faculty) diff.push('دانشکده');
      if ((e.major ?? '') !== p.major) diff.push('رشته');
      if ((e.degree ?? '') !== p.degree) diff.push('مقطع');
      if ((e.entryYear == null ? null : Number(e.entryYear)) !== p.entryYear) diff.push('سال ورود');
      if ((e.nationalIdHash ?? '') !== p.nationalIdHash) diff.push('کد ملی');
      p.kind = diff.length ? 'changed' : 'unchanged';
      p.changes = diff;
    }

    const fingerprint = await sha256(JSON.stringify(parsed.map((p) => [p.studentNumber, p.nationalIdHash, p.fullName, p.faculty, p.major, p.degree, p.entryYear])));
    const dup = await zite.importBatches.findOne({ filters: { fileFingerprint: fingerprint, status: 'Committed' } });
    const errorRows = parsed.filter((p) => p.kind === 'error');
    const summary = {
      total: parsed.length, valid: parsed.length - errorRows.length, errors: errorRows.length,
      new: parsed.filter((p) => p.kind === 'new').length, changed: parsed.filter((p) => p.kind === 'changed').length, unchanged: parsed.filter((p) => p.kind === 'unchanged').length,
    };
    const staged = parsed.filter((p) => p.kind === 'new' || p.kind === 'changed').map(({ errors: _e, changes: _c, ...rest }) => rest);
    const errorReport = errorRows.map((p) => ({ rowNumber: p.rowNumber, studentNumber: p.studentNumber, errors: p.errors }));
    const batch = await db.importBatches.create({
      record: {
        fileName: input.fileName, uploadedBy: [staff.id], status: 'Preview', policy: input.policy, totalRows: summary.total, validRows: summary.valid,
        errorRows: summary.errors, newRows: summary.new, changedRows: summary.changed, stagedData: JSON.stringify(staged), errorReport: JSON.stringify(errorReport), fileFingerprint: fingerprint,
      },
    });
    await audit(staffActor(staff), 'import.preview', 'ImportBatch', batch.id, { fileName: input.fileName, ...summary });
    return {
      batchId: batch.id, summary, duplicateOfCommitted: !!dup, blocked: input.policy === 'RejectAllOnError' && summary.errors > 0,
      rows: parsed.slice(0, 1000).map((p) => ({ rowNumber: p.rowNumber, studentNumber: p.studentNumber, fullName: p.fullName, faculty: p.faculty, major: p.major, kind: p.kind, errors: p.errors, changes: p.changes })),
      errorReport,
    };
  },
});
