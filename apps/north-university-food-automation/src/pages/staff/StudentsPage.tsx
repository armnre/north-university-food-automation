import { useState } from 'react';
import { useDebounce } from 'use-debounce';
import { Search, Loader2, Download, ArrowUpDown, X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { adminStudents, adminStudentStatus } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import StudentReportSheet from '../../components/StudentReportSheet';
import { downloadCsv, errMsg, faDateTime, faDigits, faNum, rial } from '../../lib/format';
import { STUDENT_STATUS } from '../../lib/studentStatus';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type Student = { id: string; studentNumber: string; fullName: string; faculty: string; major: string; degree: string; entryYear: number | null; status: string; nationalIdMasked: string; balanceRial: number; reservations: number; addedAt: string | null; removedAt: string | null };
type Facet = { value: string; count: number };
type Resp = { total: number; students: Student[]; facets: Record<'status' | 'faculty' | 'major' | 'degree' | 'entryYear', Facet[]> };
type Filters = { status?: string; faculty?: string; major?: string; degree?: string; entryYear?: string };
type SortKey = 'studentNumber' | 'fullName' | 'balance' | 'reservations' | 'addedAt' | 'removedAt';
const ALL = '__all__';
const PAGE = 50;

function FacetSelect({ label, value, facets, onChange, fmt }: { label: string; value?: string; facets: Facet[]; onChange: (v?: string) => void; fmt?: (v: string) => string }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className={cn('h-9', value && 'border-primary')}><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>همه‌ی {label}‌ها</SelectItem>
        {facets.filter((f) => f.value).map((f) => <SelectItem key={f.value} value={f.value}>{fmt ? fmt(f.value) : f.value} ({faNum(f.count)})</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export default function StudentsPage() {
  const { token, me } = useSession();
  const canEdit = me?.kind === 'staff' && me.staff.perms.includes('studentsWrite');
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [f, setF] = useState<Filters>({});
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'studentNumber', dir: 'asc' });
  const [page, setPage] = useState(0);
  const query = (t: string, offset: number, limit: number) => adminStudents({ token: t, search: dq || undefined, status: f.status as 'Active' | undefined, faculty: f.faculty, major: f.major, degree: f.degree, entryYear: f.entryYear ? Number(f.entryYear) : undefined, sort: sort.key, dir: sort.dir, offset, limit }) as Promise<Resp>;
  const { data, error, loading, reload } = useLoad((t) => query(t, page * PAGE, PAGE), [dq, f, sort, page]);
  const [target, setTarget] = useState<Student | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const setFilter = (k: keyof Filters, v?: string) => { setF({ ...f, [k]: v }); setPage(0); };
  const toggleSort = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const nextStatus = target?.status === 'Active' ? 'Inactive' : 'Active';
  const toggle = async () => {
    if (!target) return;
    setBusy(true);
    try { await adminStudentStatus({ token, studentId: target.id, status: nextStatus }); toast.success('وضعیت دانشجو تغییر کرد.'); setTarget(null); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const exportAll = async () => {
    setExporting(true);
    try {
      const r = await query(token, 0, 2000);
      downloadCsv('students.csv', ['شماره دانشجویی', 'نام', 'دانشکده', 'رشته', 'مقطع', 'سال ورود', 'وضعیت', 'موجودی (ریال)', 'رزرو فعال/تحویلی', 'تاریخ افزودن', 'تاریخ حذف'],
        r.students.map((s) => [s.studentNumber, s.fullName, s.faculty, s.major, s.degree, s.entryYear ?? '', STUDENT_STATUS[s.status]?.label ?? s.status, s.balanceRial, s.reservations, s.addedAt ? faDateTime(s.addedAt) : '', s.removedAt ? faDateTime(s.removedAt) : '']));
    } catch (e) { toast.error(errMsg(e)); } finally { setExporting(false); }
  };
  const pages = Math.ceil((data?.total ?? 0) / PAGE);
  const hasFilter = Object.values(f).some(Boolean) || !!q;
  const SortHead = ({ k, children, className }: { k: SortKey; children: string; className?: string }) => (
    <TableHead className={cn('text-right', className)}><button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(k)}>{children}<ArrowUpDown className={cn('h-3 w-3', sort.key === k ? 'text-primary' : 'opacity-40')} /></button></TableHead>
  );

  return (
    <>
      <PageHeader title="مدیریت دانشجویان" subtitle={data ? `${faNum(data.total)} دانشجو در این دسته` : undefined}
        actions={<Button variant="outline" size="sm" onClick={exportAll} disabled={exporting || !data?.total}>{exporting ? <Loader2 className="ms-1 h-4 w-4 animate-spin" /> : <Download className="ms-1 h-4 w-4" />}خروجی فهرست</Button>} />

      <div className="mb-3 flex flex-wrap gap-2">
        {[{ v: undefined, label: 'همه' }, ...['Active', 'Inactive', 'Removed'].map((v) => ({ v, label: STUDENT_STATUS[v].label }))].map((s) => {
          const n = s.v ? data?.facets.status.find((x) => (x.value || 'Active') === s.v)?.count : undefined;
          return <button key={s.label} onClick={() => setFilter('status', s.v)} className={cn('rounded-full border px-3 py-1 text-sm transition', f.status === s.v ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:border-primary/50')}>{s.label}{n != null && f.status !== s.v ? <span className="num ms-1 opacity-70">{faNum(n)}</span> : null}</button>;
        })}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <div className="relative lg:col-span-2"><Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="h-9 pr-9" placeholder="شماره دانشجویی، نام یا رشته" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></div>
        <FacetSelect label="دانشکده" value={f.faculty} facets={data?.facets.faculty ?? []} onChange={(v) => setFilter('faculty', v)} />
        <FacetSelect label="رشته" value={f.major} facets={data?.facets.major ?? []} onChange={(v) => setFilter('major', v)} />
        <FacetSelect label="مقطع" value={f.degree} facets={data?.facets.degree ?? []} onChange={(v) => setFilter('degree', v)} />
        <FacetSelect label="ورودی" value={f.entryYear} facets={data?.facets.entryYear ?? []} onChange={(v) => setFilter('entryYear', v)} fmt={faDigits} />
      </div>
      {hasFilter && <Button size="sm" variant="ghost" className="mb-3" onClick={() => { setF({}); setQ(''); setPage(0); }}><X className="ms-1 h-4 w-4" />پاک کردن فیلترها</Button>}

      {loading && !data ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.students.length ? <EmptyState title="دانشجویی یافت نشد" text="فیلترها را تغییر دهید یا از «واردسازی Excel» دانشجو اضافه کنید." /> : (
        <div className={cn('overflow-x-auto rounded-xl border bg-card transition-opacity', loading && 'opacity-60')}>
          <Table>
            <TableHeader><TableRow>
              <SortHead k="studentNumber">شماره دانشجویی</SortHead><SortHead k="fullName">نام</SortHead>
              <TableHead className="hidden text-right md:table-cell">رشته / دانشکده / مقطع</TableHead>
              <SortHead k="balance">موجودی</SortHead><SortHead k="reservations" className="hidden sm:table-cell">رزروها</SortHead>
              <TableHead className="text-right">وضعیت</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {data.students.map((s) => (
                <TableRow key={s.id} className="cursor-pointer" onClick={() => setReportId(s.id)}>
                  <TableCell className="num font-medium">{faDigits(s.studentNumber)}</TableCell>
                  <TableCell>{s.fullName}</TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{[s.major, s.faculty, s.degree, s.entryYear ? `ورودی ${faDigits(String(s.entryYear))}` : ''].filter(Boolean).join(' · ')}</TableCell>
                  <TableCell className="num">{rial(s.balanceRial)}</TableCell>
                  <TableCell className="num hidden sm:table-cell">{faNum(s.reservations)}</TableCell>
                  <TableCell><Pill tone={STUDENT_STATUS[s.status]?.tone ?? 'muted'}>{STUDENT_STATUS[s.status]?.label ?? s.status}</Pill>{s.removedAt && s.status === 'Removed' && <div className="mt-1 text-[11px] text-muted-foreground">{faDateTime(s.removedAt)}</div>}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()} className="whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setReportId(s.id)}><FileText className="h-4 w-4" /><span className="sr-only">گزارش</span></Button>
                    {canEdit && <Button size="sm" variant="outline" onClick={() => setTarget(s)}>{s.status === 'Active' ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</Button>}
                  </TableCell>
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
      <StudentReportSheet token={token} studentId={reportId} onClose={() => setReportId(null)} />
      <Dialog open={!!target} onOpenChange={(o) => !o && !busy && setTarget(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{nextStatus === 'Inactive' ? 'غیرفعال‌سازی دانشجو' : 'فعال‌سازی دانشجو'}</DialogTitle><DialogDescription>{target?.fullName} · {target && faDigits(target.studentNumber)}{target?.status === 'Removed' && ' — این دانشجو در آخرین فایل Excel نبوده است.'}</DialogDescription></DialogHeader>
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>انصراف</Button><Button onClick={toggle} disabled={busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}تأیید</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
