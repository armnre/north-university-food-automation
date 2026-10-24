import { useState } from 'react';
import { useDebounce } from 'use-debounce';
import { Pencil, Plus, Upload } from 'lucide-react';
import { employeesList } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { faDateTime, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import EmployeeDialog, { EMP_KINDS, type Employee } from '../../components/EmployeeDialog';
import EmployeeBulkDialog from '../../components/EmployeeBulkDialog';

const PAGE = 50;

export default function EmployeesPage() {
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useLoad(async () => (await employeesList({ search: dq || undefined, offset: page * PAGE, limit: PAGE })) as { total: number; employees: Employee[] }, [dq, page]);
  const [edit, setEdit] = useState<Employee | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  return (
    <>
      <PageHeader title="کارمندان" subtitle="کارمندان، اعضای هیئت علمی و پیمانکاران با نام کاربری وارد می‌شوند و مثل دانشجو رزرو می‌کنند."
        actions={<div className="flex gap-2"><Button variant="outline" onClick={() => setBulk(true)}><Upload className="ms-1 h-4 w-4" />افزودن از فایل</Button><Button onClick={() => setEdit('new')}><Plus className="ms-1 h-4 w-4" />کارمند جدید</Button></div>} />
      <Input className="mb-4 max-w-sm" placeholder="جست‌وجوی نام، نام کاربری یا کد پرسنلی" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.employees.length ? <EmptyState title="کارمندی یافت نشد" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="text-right">نام</TableHead><TableHead className="text-right">نام کاربری</TableHead><TableHead className="text-right">نوع</TableHead>
              <TableHead className="hidden text-right md:table-cell">موجودی</TableHead><TableHead className="hidden text-right lg:table-cell">آخرین ورود</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {data.employees.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.firstName} {e.lastName}{e.personnelCode && <div className="text-xs text-muted-foreground num">{e.personnelCode}</div>}</TableCell>
                  <TableCell dir="ltr" className="text-right font-mono text-xs">{e.username}</TableCell>
                  <TableCell>{EMP_KINDS[e.kind] ?? e.kind}</TableCell>
                  <TableCell className="hidden num md:table-cell">{rial(e.balanceRial)}</TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">{faDateTime(e.lastLoginAt)}</TableCell>
                  <TableCell>{e.active ? <Pill tone="success">فعال</Pill> : <Pill tone="muted">غیرفعال</Pill>}</TableCell>
                  <TableCell><Button size="sm" variant="ghost" onClick={() => setEdit(e)} aria-label="ویرایش"><Pencil className="h-4 w-4" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="mt-4 flex items-center justify-center gap-2 text-sm">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>قبلی</Button>
        <span className="num text-muted-foreground">{faNum(page + 1)} از {faNum(pages)}</span>
        <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>بعدی</Button>
      </div>
      {edit && <EmployeeDialog employee={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {bulk && <EmployeeBulkDialog onClose={() => setBulk(false)} onSaved={reload} />}
    </>
  );
}
