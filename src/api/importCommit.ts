import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { audit, db, fail, requireStaff, staffActor } from '../server/core';

type Staged = { kind: string; studentNumber: string; fullName: string; faculty: string; major: string; degree: string; entryYear: number | null; nationalIdHash: string; nationalIdLastDigits: string };

export default createEndpoint({
  description: 'Commits a previewed import batch into Students (idempotent upsert by student number)',
  inputSchema: z.object({ token: z.string(), batchId: z.string().uuid() }),
  outputSchema: z.object({ written: z.number(), status: z.string() }),
  execute: async ({ input }) => {
    const staff = await requireStaff(input.token, 'import');
    const batch = await zite.importBatches.findOne({ id: input.batchId });
    if (!batch) fail('NOT_FOUND', 'دسته‌ی واردسازی یافت نشد.');
    if (batch.status === 'Committed') return { written: 0, status: 'Committed' };
    if (batch.status !== 'Preview' && batch.status !== 'Failed') fail('BAD_REQUEST', 'این دسته قابل ثبت نیست.');
    if (batch.policy === 'RejectAllOnError' && (batch.errorRows ?? 0) > 0) fail('BAD_REQUEST', 'طبق سیاست انتخاب‌شده، به دلیل وجود ردیف‌های خطادار، واردسازی انجام نمی‌شود.');
    const staged: Staged[] = JSON.parse(batch.stagedData || '[]');
    let written = 0;
    try {
      for (let i = 0; i < staged.length; i += 100) {
        // New students start Active; existing students keep their current status (an import never silently re-activates).
        const chunk = staged.slice(i, i + 100).map(({ kind, ...s }) => ({ ...s, ...(kind === 'new' ? { status: 'Active' } : {}), lastImportBatch: batch.id }));
        await db.students.bulkCreate({ records: chunk, matchOn: ['studentNumber'] });
        written += chunk.length;
      }
    } catch (e) {
      await db.importBatches.update({ id: batch.id, record: { status: 'Failed' } });
      await audit(staffActor(staff), 'import.failed', 'ImportBatch', batch.id, { written, total: staged.length });
      console.error('import commit failed', e instanceof Error ? e.message : 'unknown');
      fail('INTERNAL_ERROR', `واردسازی پس از ثبت ${written} ردیف متوقف شد. می‌توانید دوباره «تأیید نهایی» را بزنید؛ ردیف‌های ثبت‌شده تکرار نمی‌شوند.`);
    }
    await db.importBatches.update({ id: batch.id, record: { status: 'Committed', stagedData: '' } });
    await audit(staffActor(staff), 'import.commit', 'ImportBatch', batch.id, { written });
    return { written, status: 'Committed' };
  },
});
