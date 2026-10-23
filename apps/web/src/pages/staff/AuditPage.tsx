import { useState } from 'react';
import { useDebounce } from 'use-debounce';
import { auditList } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '../../components/ui-kit';
import { faDateTime } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

type Log = { id: string; action: string; actorType: string; actorLabel: string; targetType: string; targetId: string; details: string; createdAt: string };

export default function AuditPage() {
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useLoad(async () => (await auditList({ search: dq || undefined, offset: page * 100 })) as { logs: Log[]; hasMore: boolean }, [dq, page]);
  return (
    <>
      <PageHeader title="رخدادهای ممیزی" subtitle="سوابق فقط‌خواندنی عملیات حساس. کد ملی در هیچ رخدادی ثبت نمی‌شود." />
      <Input className="mb-4 max-w-sm" placeholder="جست‌وجو (مثلاً login، ledger، import)" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.logs.length ? <EmptyState title="رخدادی یافت نشد" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">زمان</TableHead><TableHead className="text-right">رخداد</TableHead><TableHead className="text-right">انجام‌دهنده</TableHead><TableHead className="hidden text-right md:table-cell">هدف</TableHead><TableHead className="hidden text-right lg:table-cell">جزئیات</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-xs">{faDateTime(l.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs" dir="ltr">{l.action}</TableCell>
                  <TableCell className="text-sm">{l.actorLabel || '—'}<div className="text-[11px] text-muted-foreground">{l.actorType}</div></TableCell>
                  <TableCell className="hidden text-xs md:table-cell">{l.targetType}</TableCell>
                  <TableCell className="hidden max-w-sm truncate font-mono text-[11px] text-muted-foreground lg:table-cell" dir="ltr" title={l.details}>{l.details}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="mt-4 flex justify-center gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>قبلی</Button><Button size="sm" variant="outline" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>بعدی</Button></div>
    </>
  );
}
