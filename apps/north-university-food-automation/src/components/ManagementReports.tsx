import { Download } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { reportsAdvanced } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { ErrorState, LoadingBlock, Section, StatCard } from './ui-kit';
import { LEDGER_TYPES, MEALS, downloadCsv, faNum, faShort, rial } from '../lib/format';
import { useLoad } from '../lib/useLoad';

type G = { key: string; students: number; reserved: number; delivered: number; cancelled: number; valueRial: number };
type Data = {
  daily: { date: string; reserved: number; delivered: number; cancelled: number; noShow: number; valueRial: number }[];
  meals: G[]; foods: G[]; faculty: G[]; major: G[];
  ledger?: { type: string; count: number; amountRial: number }[];
  ledgerDaily?: { date: string; inRial: number; outRial: number }[];
  wallets?: { students: number; totalRial: number; positive: number; negative: number; maxRial: number };
  students: { total: number; active: number; inactive: number; removed: number; engaged: number };
  offerings: number;
};
const pct = (a: number, b: number) => (b ? `${faNum(Math.round((a / b) * 100))}٪` : '—');
const short = (n: number) => (Math.abs(n) >= 1e9 ? `${faNum(+(n / 1e9).toFixed(1))} میلیارد` : Math.abs(n) >= 1e6 ? `${faNum(+(n / 1e6).toFixed(1))} م` : faNum(n));
const tip = { contentStyle: { direction: 'rtl' as const, borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', fontSize: 12 } };

function GroupTable({ title, rows, file, showStudents }: { title: string; rows: G[]; file: string; showStudents?: boolean }) {
  return (
    <Section title={title} actions={<Button size="sm" variant="ghost" disabled={!rows.length} onClick={() => downloadCsv(file, [title, 'دانشجو', 'رزرو', 'تحویل', 'نرخ مراجعه', 'ارزش (ریال)'], rows.map((r) => [r.key, r.students, r.reserved, r.delivered, pct(r.delivered, r.reserved), r.valueRial]))}><Download className="h-4 w-4" /></Button>}>
      {!rows.length ? <p className="py-4 text-center text-sm text-muted-foreground">داده‌ای نیست</p> : (
        <div className="max-h-80 overflow-auto">
          <Table><TableHeader><TableRow><TableHead className="text-right">عنوان</TableHead>{showStudents && <TableHead className="text-right">دانشجو</TableHead>}<TableHead className="text-right">رزرو</TableHead><TableHead className="text-right">تحویل</TableHead><TableHead className="hidden text-right sm:table-cell">ارزش</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((r) => <TableRow key={r.key}><TableCell className="max-w-[160px] truncate">{MEALS[r.key] ?? r.key}</TableCell>{showStudents && <TableCell className="num">{faNum(r.students)}</TableCell>}<TableCell className="num">{faNum(r.reserved)}</TableCell><TableCell className="num">{faNum(r.delivered)} <span className="text-[10px] text-muted-foreground">{pct(r.delivered, r.reserved)}</span></TableCell><TableCell className="num hidden whitespace-nowrap text-xs sm:table-cell">{rial(r.valueRial)}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

export default function ManagementReports({ from, to }: { from: string; to: string }) {
  const { data, error, loading, reload } = useLoad(async (t) => (await reportsAdvanced({ token: t, from, to })) as Data, [from, to]);
  if (loading) return <LoadingBlock rows={6} />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  const tot = data.daily.reduce((a, d) => ({ reserved: a.reserved + d.reserved, delivered: a.delivered + d.delivered, cancelled: a.cancelled + d.cancelled, noShow: a.noShow + d.noShow, value: a.value + d.valueRial }), { reserved: 0, delivered: 0, cancelled: 0, noShow: 0, value: 0 });
  const ledger = data.ledger ?? [];
  const credits = ledger.filter((l) => l.amountRial > 0).reduce((a, l) => a + l.amountRial, 0);
  const debits = -ledger.filter((l) => l.amountRial < 0).reduce((a, l) => a + l.amountRial, 0);
  const exportAll = () => downloadCsv(`management-${from}-${to}.csv`, ['بخش', 'عنوان', 'مقدار ۱', 'مقدار ۲', 'مقدار ۳', 'مبلغ (ریال)'], [
    ...data.daily.map((d) => ['روزانه', d.date, d.reserved, d.delivered, d.noShow, d.valueRial]),
    ...ledger.map((l) => ['مالی', LEDGER_TYPES[l.type] ?? l.type, l.count, '', '', l.amountRial]),
    ...data.faculty.map((g) => ['دانشکده', g.key, g.students, g.reserved, g.delivered, g.valueRial]),
    ...data.major.map((g) => ['رشته', g.key, g.students, g.reserved, g.delivered, g.valueRial]),
    ...data.foods.map((g) => ['غذا', g.key, g.reserved, g.delivered, g.cancelled, g.valueRial]),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><Button variant="outline" size="sm" onClick={exportAll}><Download className="ms-1 h-4 w-4" />خروجی کامل گزارش مدیریتی</Button></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard tone="primary" label="ارزش رزروها" value={rial(tot.value)} hint={`${faNum(data.offerings)} وعده‌ی تعریف‌شده`} />
        <StatCard label="رزرو / تحویل" value={`${faNum(tot.reserved)} / ${faNum(tot.delivered)}`} hint={`نرخ مراجعه ${pct(tot.delivered, tot.delivered + tot.noShow)}`} />
        <StatCard label="لغو / عدم مراجعه" value={`${faNum(tot.cancelled)} / ${faNum(tot.noShow)}`} />
        <StatCard label="دانشجویان فعال در بازه" value={faNum(data.students.engaged)} hint={`از ${faNum(data.students.active)} دانشجوی فعال · ${pct(data.students.engaged, data.students.active)}`} />
        <StatCard label="واریز به کیف پول‌ها" value={rial(credits)} />
        <StatCard label="برداشت از کیف پول‌ها" value={rial(debits)} />
        {data.wallets && <StatCard label="مانده‌ی کل کیف پول‌ها" value={rial(data.wallets.totalRial)} hint={`${faNum(data.wallets.positive)} دارای موجودی · ${faNum(data.wallets.negative)} منفی`} />}
        <StatCard label="وضعیت دانشجویان" value={faNum(data.students.total)} hint={`فعال ${faNum(data.students.active)} · غیرفعال ${faNum(data.students.inactive)} · حذف ${faNum(data.students.removed)}`} />
      </div>

      <Section title="روند روزانه‌ی رزرو و تحویل">
        <div className="h-64 w-full" dir="ltr">
          <ResponsiveContainer><AreaChart data={data.daily.map((d) => ({ ...d, label: faShort(d.date) }))} margin={{ left: -10, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="reserved" name="رزرو" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1) / 0.2)" strokeWidth={2} />
            <Area type="monotone" dataKey="delivered" name="تحویل" stroke="hsl(var(--chart-2))" fill="hsl(var(--chart-2) / 0.2)" strokeWidth={2} />
            <Area type="monotone" dataKey="noShow" name="عدم مراجعه" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive) / 0.1)" strokeWidth={1.5} />
          </AreaChart></ResponsiveContainer>
        </div>
      </Section>

      {data.ledgerDaily && <div className="grid gap-6 lg:grid-cols-2">
        <Section title="گردش مالی روزانه (ریال)">
          <div className="h-60 w-full" dir="ltr">
            <ResponsiveContainer><BarChart data={(data.ledgerDaily ?? []).map((d) => ({ ...d, label: faShort(d.date) }))} margin={{ left: 0, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 10 }} tickFormatter={short} width={56} />
              <Tooltip {...tip} formatter={(v: number) => rial(v)} /><Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="inRial" name="واریز" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} /><Bar dataKey="outRial" name="برداشت" fill="hsl(var(--chart-4))" radius={[4, 4, 0, 0]} />
            </BarChart></ResponsiveContainer>
          </div>
        </Section>
        <Section title="تفکیک تراکنش‌های مالی">
          {!ledger.length ? <p className="py-6 text-center text-sm text-muted-foreground">تراکنشی در این بازه نیست</p> : (
            <Table><TableHeader><TableRow><TableHead className="text-right">نوع</TableHead><TableHead className="text-right">تعداد</TableHead><TableHead className="text-right">جمع مبلغ</TableHead></TableRow></TableHeader>
              <TableBody>{ledger.map((l) => <TableRow key={l.type}><TableCell>{LEDGER_TYPES[l.type] ?? l.type}</TableCell><TableCell className="num">{faNum(l.count)}</TableCell><TableCell className={`num whitespace-nowrap ${l.amountRial < 0 ? 'text-destructive' : 'text-[hsl(var(--success))]'}`}>{rial(l.amountRial)}</TableCell></TableRow>)}
                <TableRow className="font-semibold"><TableCell>خالص</TableCell><TableCell /><TableCell className="num whitespace-nowrap">{rial(credits - debits)}</TableCell></TableRow></TableBody>
            </Table>
          )}
        </Section>
      </div>}

      <div className="grid gap-6 lg:grid-cols-2">
        <GroupTable title="مصرف به تفکیک دانشکده" rows={data.faculty} file="by-faculty.csv" showStudents />
        <GroupTable title="مصرف به تفکیک رشته" rows={data.major} file="by-major.csv" showStudents />
        <GroupTable title="پرطرفدارترین غذاها" rows={data.foods} file="top-foods.csv" />
        <GroupTable title="تفکیک وعده‌ها" rows={data.meals} file="by-meal.csv" />
      </div>
    </div>
  );
}
