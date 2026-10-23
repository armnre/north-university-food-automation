import { useState } from 'react';
import { Download } from 'lucide-react';
import { catalogList, reportsSummary } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, StatCard } from '../../components/ui-kit';
import { MEALS, addDays, downloadCsv, faDate, faNum, rial, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { Catalog } from '../../lib/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@project/components/ui/tabs';
import ManagementReports from '../../components/ManagementReports';

type Row = { id: string; date: string; meal: string; cafeteria: string; food: string; capacity: number; reserved: number; delivered: number; cancelled: number; noShow: number; valueRial: number };
type Data = { rows: Row[]; totals: Omit<Row, 'id' | 'date' | 'meal' | 'cafeteria' | 'food'>; scopedToContractor: boolean };
const ALL = '__all__';

export default function ReportsPage({ contractor }: { contractor?: boolean }) {
  const [from, setFrom] = useState(addDays(tehranToday(), -30));
  const [to, setTo] = useState(tehranToday());
  const [caf, setCaf] = useState(ALL);
  const [meal, setMeal] = useState(ALL);
  const cat = useLoad(async () => (contractor ? null : ((await catalogList()) as Catalog)));
  const { data, error, loading, reload } = useLoad(async () => (await reportsSummary({ from, to, cafeteriaId: caf === ALL ? undefined : caf, mealSlot: meal === ALL ? undefined : meal })) as Data, [from, to, caf, meal]);
  const pct = (a: number, b: number) => (b ? `${faNum(Math.round((a / b) * 100))}٪` : '—');
  const exportCsv = () => data && downloadCsv('report.csv', ['تاریخ', 'وعده', 'سلف', 'غذا', 'ظرفیت', 'رزرو', 'تحویل', 'لغو', 'عدم مراجعه', 'ارزش (ریال)'], data.rows.map((r) => [r.date, MEALS[r.meal] ?? r.meal, r.cafeteria, r.food, r.capacity, r.reserved, r.delivered, r.cancelled, r.noShow, r.valueRial]));
  return (
    <>
      <PageHeader title={contractor ? 'گزارش پیمانکار' : 'گزارش‌های عملیاتی و مالی'} subtitle={contractor ? 'فقط سلف‌های مربوط به قرارداد شما نمایش داده می‌شود. اطلاعات هویتی دانشجویان در این گزارش وجود ندارد.' : 'ارزش رزروها بر اساس قیمت لحظه‌ی رزرو محاسبه می‌شود.'} actions={<Button variant="outline" onClick={exportCsv} disabled={!data?.rows.length}><Download className="ms-1 h-4 w-4" />خروجی CSV</Button>} />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="از تاریخ" />
        <Input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} aria-label="تا تاریخ" />
        <Select value={meal} onValueChange={setMeal}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>همه‌ی وعده‌ها</SelectItem>{Object.entries(MEALS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
        {!contractor && <Select value={caf} onValueChange={setCaf}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>همه‌ی سلف‌ها</SelectItem>{cat.data?.cafeterias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select>}
      </div>
      <Tabs defaultValue={contractor ? 'ops' : 'mgmt'}>
      {!contractor && <TabsList className="mb-4"><TabsTrigger value="mgmt">مدیریتی و مالی</TabsTrigger><TabsTrigger value="ops">ریز وعده‌ها</TabsTrigger></TabsList>}
      {!contractor && <TabsContent value="mgmt"><ManagementReports from={from} to={to} /></TabsContent>}
      <TabsContent value="ops">
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data ? null : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="رزرو" value={faNum(data.totals.reserved)} hint={`ظرفیت ${faNum(data.totals.capacity)} · ${pct(data.totals.reserved, data.totals.capacity)}`} />
            <StatCard label="تحویل" value={faNum(data.totals.delivered)} hint={pct(data.totals.delivered, data.totals.reserved)} />
            <StatCard label="لغو" value={faNum(data.totals.cancelled)} />
            <StatCard label="عدم مراجعه" value={faNum(data.totals.noShow)} hint={pct(data.totals.noShow, data.totals.reserved)} />
            <StatCard tone="primary" label="ارزش رزروها" value={rial(data.totals.valueRial)} />
          </div>
          {data.rows.length === 0 ? <EmptyState title="در این بازه داده‌ای وجود ندارد" /> : (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <Table>
                <TableHeader><TableRow><TableHead className="text-right">تاریخ</TableHead><TableHead className="text-right">وعده</TableHead><TableHead className="text-right">غذا</TableHead><TableHead className="hidden text-right md:table-cell">سلف</TableHead><TableHead className="text-right">رزرو/ظرفیت</TableHead><TableHead className="text-right">تحویل</TableHead><TableHead className="hidden text-right sm:table-cell">لغو</TableHead><TableHead className="text-right">عدم مراجعه</TableHead><TableHead className="text-right">ارزش</TableHead></TableRow></TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-sm">{faDate(r.date)}</TableCell><TableCell>{MEALS[r.meal]}</TableCell><TableCell>{r.food}</TableCell><TableCell className="hidden md:table-cell">{r.cafeteria}</TableCell>
                      <TableCell className="num">{faNum(r.reserved)} / {faNum(r.capacity)}</TableCell><TableCell className="num">{faNum(r.delivered)}</TableCell><TableCell className="num hidden sm:table-cell">{faNum(r.cancelled)}</TableCell>
                      <TableCell className="num">{faNum(r.noShow)}</TableCell><TableCell className="num whitespace-nowrap">{rial(r.valueRial)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      </TabsContent>
      </Tabs>
    </>
  );
}
