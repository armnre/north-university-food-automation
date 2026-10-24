import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { requirePrincipal } from '../lib/auth.js';
import { iso } from '../lib/customer.js';
import { fail } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { buildPreview, csvSafe, guessMapping, MAX_BYTES, parseXlsx, type FieldKey, type PreviewRow } from '../services/imports.js';
import { revokeAllForSubject } from '../services/sessions.js';

export function importRoutes(app: FastifyInstance, db: Db, env: Env) {
  const acc = { config: { access: 'importsManage' as const } };

  app.post('/api/v1/imports/preview', acc, async (req) => {
    const p = requirePrincipal(req);
    const parts = req.parts({ limits: { fileSize: MAX_BYTES, files: 1 } });
    let buf: Buffer | null = null;
    let fileName = '';
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!/\.xlsx$/i.test(part.filename)) fail('BAD_REQUEST', 'فقط فایل اکسل ‎.xlsx‎ پذیرفته می‌شود.');
        fileName = part.filename.slice(0, 200);
        buf = await part.toBuffer();
        if (part.file.truncated) fail('BAD_REQUEST', 'حجم فایل بیش از ۵ مگابایت است.');
      } else fields[part.fieldname] = String(part.value).slice(0, 5000);
    }
    if (!buf) fail('BAD_REQUEST', 'فایلی ارسال نشده است.');
    const fullSync = fields.fullSync === 'true';
    const { headers, data } = await parseXlsx(buf);
    const mapping = fields.mapping ? (z.record(z.string()).parse(JSON.parse(fields.mapping)) as Partial<Record<FieldKey, string>>) : guessMapping(headers);
    const pv = await buildPreview(db, env.NATIONAL_ID_PEPPER, headers, data, mapping);
    const count = (k: PreviewRow['kind']) => pv.rows.filter((r) => r.kind === k).length;
    const summary = {
      total: pv.rows.length,
      NEW: count('NEW'),
      UPDATE: count('UPDATE'),
      UNCHANGED: count('UNCHANGED'),
      CONFLICT: count('CONFLICT'),
      ERROR: count('ERROR'),
      REMOVED: fullSync ? pv.removed.length : 0,
    };
    const massRemovalWarning = fullSync && pv.activeCount > 0 && pv.removed.length / pv.activeCount > 0.2;
    const batchId = await db.transaction(async (tx) => {
      const b = await tx.execute<{ id: string }>(
        sql`INSERT INTO import_batches (kind, file_name, full_sync, summary, created_by) VALUES ('students', ${fileName}, ${fullSync}, ${JSON.stringify({ ...summary, policy: fields.policy ?? 'RejectAllOnError', removed: fullSync ? pv.removed : [] })}::jsonb, ${p.id}) RETURNING id`,
      );
      const id = b.rows[0]!.id;
      for (let i = 0; i < pv.rows.length; i += 500) {
        const chunk = pv.rows.slice(i, i + 500);
        await tx.execute(
          sql`INSERT INTO import_rows (batch_id, row_number, action, student_number, payload, errors) SELECT ${id}, x.rn, x.action, x.sn, x.payload, x.errors FROM jsonb_to_recordset(${JSON.stringify(chunk.map((r) => ({ rn: r.rowNumber, action: r.kind, sn: r.studentNumber, payload: r.payload ?? null, errors: r.errors })))}::jsonb) AS x(rn int, action text, sn text, payload jsonb, errors jsonb)`,
        );
      }
      await audit(tx, { actor: p.actor, action: 'import.preview', entityType: 'ImportBatch', entityId: id, data: summary, requestId: req.id });
      return id;
    });
    const errorCsv =
      '\ufeff' +
      [
        'شماره ردیف,شماره دانشجویی,خطاها',
        ...pv.rows.filter((r) => r.errors.length).map((r) => [String(r.rowNumber), r.studentNumber, r.errors.join(' | ')].map(csvSafe).join(',')),
      ].join('\n');
    return {
      batchId,
      headers,
      mapping,
      summary,
      massRemovalWarning,
      removed: fullSync ? pv.removed : [],
      rows: pv.rows.slice(0, 2000).map(({ payload: _p, ...r }) => r),
      truncated: pv.rows.length > 2000,
      errorReport: pv.rows.filter((r) => r.errors.length).map((r) => ({ rowNumber: r.rowNumber, studentNumber: r.studentNumber, errors: r.errors })),
      errorCsv,
    };
  });

  app.post('/api/v1/imports/:id/approve-conflict', acc, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ rowNumber: z.number().int().min(2), reason: z.string().trim().min(5).max(300) }).parse(req.body);
    const r = await db.execute<{
      student_number: string;
    }>(sql`UPDATE import_rows SET conflict_approved=true WHERE batch_id=${id} AND row_number=${b.rowNumber} AND action='CONFLICT'
      AND EXISTS (SELECT 1 FROM import_batches WHERE id=${id} AND status='Previewed') RETURNING student_number`);
    if (!r.rows[0]) fail('NOT_FOUND', 'ردیف تعارض پیدا نشد.');
    await audit(db, {
      actor: p.actor,
      action: 'import.approve-nid-conflict',
      entityType: 'ImportBatch',
      entityId: id,
      data: { rowNumber: b.rowNumber, studentNumber: r.rows[0].student_number, reason: b.reason },
      requestId: req.id,
    });
    return { ok: true };
  });

  app.post('/api/v1/imports/:id/commit', acc, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return db.transaction(async (tx) => {
      const b = (
        await tx.execute<{ status: string; full_sync: boolean; summary: { policy?: string; removed?: string[]; ERROR: number } }>(
          sql`SELECT status, full_sync, summary FROM import_batches WHERE id=${id} FOR UPDATE`,
        )
      ).rows[0];
      if (!b) fail('NOT_FOUND', 'دسته‌ی ایمپورت پیدا نشد.');
      if (b.status !== 'Previewed') fail('CONFLICT', 'این دسته قبلاً ثبت یا لغو شده است.');
      if (b.summary.ERROR > 0 && b.summary.policy !== 'SkipInvalidRows') fail('BAD_REQUEST', 'فایل دارای ردیف خطادار است؛ ابتدا خطاها را اصلاح کنید.');
      const rows = await tx.execute<{
        action: string;
        payload: {
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
        conflict_approved: boolean;
      }>(sql`SELECT action, payload, conflict_approved FROM import_rows WHERE batch_id=${id} AND action IN ('NEW','UPDATE','CONFLICT') ORDER BY row_number`);
      let created = 0,
        updated = 0,
        conflicts = 0,
        removed = 0,
        skippedConflicts = 0;
      for (const r of rows.rows) {
        const x = r.payload;
        if (r.action === 'NEW') {
          const s = await tx.execute<{
            id: string;
          }>(sql`INSERT INTO students (student_number, national_id_hash, national_id_last4, first_name, last_name, faculty, major, degree, entry_year, mobile, last_import_batch_id)
            VALUES (${x.studentNumber}, ${x.nidHash}, ${x.last4}, ${x.firstName}, ${x.lastName}, ${x.faculty}, ${x.major}, ${x.degree}, ${x.entryYear}, ${x.mobile}, ${id}) RETURNING id`);
          await tx.execute(sql`INSERT INTO accounts (kind, student_id) VALUES ('Customer', ${s.rows[0]!.id})`);
          created++;
        } else if (r.action === 'UPDATE' || (r.action === 'CONFLICT' && r.conflict_approved)) {
          const s = await tx.execute<{
            id: string;
          }>(sql`UPDATE students SET first_name=${x.firstName}, last_name=${x.lastName}, faculty=${x.faculty}, major=${x.major}, degree=${x.degree}, entry_year=${x.entryYear},
            mobile=COALESCE(${x.mobile}, mobile), status='Active', national_id_hash=${x.nidHash}, national_id_last4=${x.last4}, updated_at=now() WHERE student_number=${x.studentNumber} RETURNING id`);
          if (r.action === 'CONFLICT') {
            conflicts++;
            await revokeAllForSubject(tx as unknown as Db, 'student', s.rows[0]!.id);
          } else updated++;
        } else skippedConflicts++;
      }
      if (b.full_sync) {
        for (const sn of b.summary.removed ?? []) {
          const s = await tx.execute<{ id: string }>(
            sql`UPDATE students SET status='Removed', updated_at=now() WHERE student_number=${sn} AND status='Active' RETURNING id`,
          );
          if (s.rows[0]) {
            removed++;
            await revokeAllForSubject(tx as unknown as Db, 'student', s.rows[0].id);
          }
        }
      }
      const result = { created, updated, conflicts, skippedConflicts, removed };
      await tx.execute(
        sql`UPDATE import_batches SET status='Committed', committed_at=now(), summary = summary || ${JSON.stringify({ result })}::jsonb, updated_at=now() WHERE id=${id}`,
      );
      await audit(tx, { actor: p.actor, action: 'import.commit', entityType: 'ImportBatch', entityId: id, data: result, requestId: req.id });
      return { ok: true, ...result };
    });
  });

  app.post('/api/v1/imports/:id/cancel', acc, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await db.execute(sql`UPDATE import_batches SET status='Cancelled', updated_at=now() WHERE id=${id} AND status='Previewed' RETURNING id`);
    if (!r.rows[0]) fail('CONFLICT', 'این دسته قابل لغو نیست.');
    await db.execute(sql`DELETE FROM import_rows WHERE batch_id=${id}`);
    await audit(db, { actor: p.actor, action: 'import.cancel', entityType: 'ImportBatch', entityId: id, requestId: req.id });
    return { ok: true };
  });

  /** Undo the most recent committed batch: soft-removes students it CREATED that have no activity at all. Updates are not reverted. */
  app.post('/api/v1/imports/:id/undo', acc, async (req) => {
    const p = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return db.transaction(async (tx) => {
      const last = await tx.execute<{ id: string }>(sql`SELECT id FROM import_batches WHERE status='Committed' ORDER BY committed_at DESC LIMIT 1 FOR UPDATE`);
      if (last.rows[0]?.id !== id) fail('CONFLICT', 'فقط آخرین دسته‌ی ثبت‌شده قابل بازگردانی است.');
      const r = await tx.execute<{ id: string }>(sql`UPDATE students s SET status='Removed', deleted_at=now(), updated_at=now()
        WHERE s.last_import_batch_id=${id} AND s.deleted_at IS NULL AND s.last_login_at IS NULL
          AND s.created_at >= (SELECT created_at FROM import_batches WHERE id=${id})
          AND NOT EXISTS (SELECT 1 FROM accounts a JOIN ledger_entries e ON e.account_id=a.id WHERE a.student_id=s.id)
          AND NOT EXISTS (SELECT 1 FROM accounts a JOIN reservations rv ON rv.account_id=a.id WHERE a.student_id=s.id)
        RETURNING s.id`);
      await tx.execute(
        sql`UPDATE import_batches SET status='Undone', summary = summary || ${JSON.stringify({ undone: r.rows.length })}::jsonb, updated_at=now() WHERE id=${id}`,
      );
      await audit(tx, { actor: p.actor, action: 'import.undo', entityType: 'ImportBatch', entityId: id, data: { removed: r.rows.length }, requestId: req.id });
      return { ok: true, removed: r.rows.length };
    });
  });

  app.get('/api/v1/imports', acc, async () => {
    const r = await db.execute<Record<string, unknown>>(
      sql`SELECT b.id, b.file_name, b.status, b.full_sync, b.summary, b.created_at, b.committed_at, su.full_name AS by FROM import_batches b LEFT JOIN staff_users su ON su.id=b.created_by ORDER BY b.created_at DESC LIMIT 50`,
    );
    return {
      batches: r.rows.map((x) => {
        const { removed: _r, ...summary } = (x.summary ?? {}) as Record<string, unknown>;
        return {
          id: x.id,
          fileName: x.file_name,
          status: x.status,
          fullSync: x.full_sync,
          summary,
          createdAt: iso(x.created_at as Date),
          committedAt: iso(x.committed_at as Date),
          createdBy: x.by ?? '',
        };
      }),
    };
  });
}
