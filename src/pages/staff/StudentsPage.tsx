import { useState } from 'react';
import { useDebounce } from 'use-debounce';
import { Search, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { adminStudents, adminStudentStatus } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Textarea } from '@project/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { errMsg, faDigits, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type Student = { id: string; studentNumber: string; fullName: string; faculty: string; major: string; degree: string; entryYear: number | null; status: string; nationalIdMasked: string; balanceRial: number };

export default function StudentsPage() {
  const { token, me } = useSession();
  const canEdit = me?.kind === 'staff' && me.staff.perms.includes('students');
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [status, setStatus] = useState<'all' | 'Active' | 'Inactive'>('all');
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useLoad(async (t) => (await adminStudents({ token: t, search: dq || undefined, status: status === 'all' ? undefined : status, offset: page * 50 })) as { total: number; students: Student[] }, [dq, status, page]);
  const [target, setTarget] = useState<Student | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!target) return;
    setBusy(true);
    try { await adminStudentStatus({ token, studentId: target.id, status: target.status === 'Active' ? 'Inactive' : 'Active', reason }); toast.success('وضعیت دانشجو تغییر کرد.'); setTarget(null); setReason(''); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const pages = Math.ceil((data?.total ?? 0) / 50);
  return (
    <>
      <PageHeader title="مدیریت دانشجویان" subtitle={data ? `${faNum(data.total)} دانشجو` : undefined} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1"><Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pr-9" placeholder="جست‌وجو با شماره دانشجویی، نام یا رشته" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></div>
        <Select value={status} onValueChange={(v) => { setStatus(v as typeof status); setPage(0); }}>
          <SelectTrigger className="sm:w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">همه</SelectItem><SelectItem value="Active">فعال</SelectItem><SelectItem value="Inactive">غیرفعال</SelectItem></SelectContent>
        </Select>
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.students.length ? <EmptyState title="دانشجویی یافت نشد" text="برای افزودن دانشجو از «واردسازی Excel» استفاده کنید." /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">شماره دانشجویی</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="hidden text-right md:table-cell">رشته / دانشکده</TableHead><TableHead className="hidden text-right sm:table-cell">کد ملی</TableHead><TableHead className="text-right">موجودی</TableHead><TableHead className="text-right">وضعیت</TableHead>{canEdit && <TableHead />}</TableRow></TableHeader>
            <TableBody>
              {data.students.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="num font-medium">{faDigits(s.studentNumber)}</TableCell>
                  <TableCell>{s.fullName}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{s.major}{s.faculty && ` · ${s.faculty}`}</TableCell>
                  <TableCell className="hidden font-mono text-xs sm:table-cell" dir="ltr">{s.nationalIdMasked}</TableCell>
                  <TableCell className="num">{rial(s.balanceRial)}</TableCell>
                  <TableCell><Pill tone={s.status === 'Active' ? 'success' : 'muted'}>{s.status === 'Active' ? 'فعال' : 'غیرفعال'}</Pill></TableCell>
                  {canEdit && <TableCell><Button size="sm" variant="outline" onClick={() => setTarget(s)}>{s.status === 'Active' ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</Button></TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>قبلی</Button>
          <span className="num">صفحه {faNum(page + 1)} از {faNum(pages)}</span>
          <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>بعدی</Button>
        </div>
      )}
      <Dialog open={!!target} onOpenChange={(o) => !o && !busy && setTarget(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{target?.status === 'Active' ? 'غیرفعال‌سازی دانشجو' : 'فعال‌سازی دانشجو'}</DialogTitle><DialogDescription>{target?.fullName} · {target && faDigits(target.studentNumber)}. ثبت دلیل برای ممیزی الزامی است.</DialogDescription></DialogHeader>
          <Textarea placeholder="دلیل تغییر وضعیت" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>انصراف</Button><Button onClick={toggle} disabled={busy || reason.trim().length < 3}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}تأیید</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
