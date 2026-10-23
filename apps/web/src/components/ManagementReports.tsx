import { Download } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { reportsAdvanced } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { ErrorState, LoadingBlock, Section, StatCard } from './ui-kit';
import { LEDGER_TYPES, MEALS, downloadCsv, faNum, faShort, rial } from '../lib/format';
import { useLoad } from '../lib/useLoad';

type G = {
  key: string;
  students: number;
  reserved: number;
  delivered: number;
  cancelled: number;
  noShow: number;
  valueRial: number;
};

type Data = {
  daily: { date: string; reserved: number; delivered: number; cancelled: number; noShow: number; valueRial: number }[];
  foods: G[];
  faculty: G[];
  byCustomerGroup: G[];
  ledger: { type: string; count: number; amountRial: number }[];
  wallets: { accounts: number; totalRial: number; positive: number; maxRial: number };
  students: {
    total: number;
    active: number;
    onLeave: number;
    graduated: number;
    withdrawn: number;
    removed: number;
  };
};

const GROUP_LABELS: Record<string, string> = {
  Student: 'دانشجویان',
  Employee: 'کارکنان',
  Faculty: 'اعضای هیئت‌علمی',
  Contractor: 'پیمانکاران',
};

const pct = (a: number, b: number) => (b ? `${faNum(Math.round((a / b) * 100))}٪` : '—');
const tip = {
  contentStyle: {
    direction: 'rtl' as const,
    borderRadius: 12,
    border: '1px solid hsl(var(--border))',
    background: 'hsl(var(--card))',
    fontSize: 12,
  },
};

function GroupTable({ title, rows, file, showStudents }: { title: string; rows: G[]; file: string; showStudents?: boolean }) {
  return (
    <Section
      title={title}
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={!rows.length}
          onClick={() =>
            downloadCsv(
              file,
              [title, 'دانشجو', 'رزرو', 'تحویل', 'لغو', 'عدم مراجعه', 'ارزش (ریال)'],
              rows.map((r) => [
                GROUP_LABELS[r.key] ?? MEALS[r.key] ?? r.key,
                r.students,
                r.reserved,
                r.delivered,
                r.cancelled,
                r.noShow,
                r.valueRial,
              ]),
            )
          }
        >
          <Download className="h-4 w-4" />
        </Button>
      }
    >
      {!rows.length ? (
        <p className="py-4 text-center text-sm text-muted-foreground">داده‌ای نیست</p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">عنوان</TableHead>
                {showStudents && <TableHead className="text-right">دانشجو</TableHead>}
                <TableHead className="text-right">رزرو</TableHead>
                <TableHead className="text-right">تحویل</TableHead>
                <TableHead className="text-right">لغو / عدم مراجعه</TableHead>
                <TableHead className="hidden text-right sm:table-cell">ارزش</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="max-w-[160px] truncate">{GROUP_LABELS[r.key] ?? MEALS[r.key] ?? r.key}</TableCell>
                  {showStudents && <TableCell className="num">{faNum(r.students)}</TableCell>}
                  <TableCell className="num">{faNum(r.reserved)}</TableCell>
                  <TableCell className="num">
                    {faNum(r.delivered)} <span className="text-[10px] text-muted-foreground">{pct(r.delivered, r.reserved)}</span>
                  </TableCell>
                  <TableCell className="num text-xs">
                    {faNum(r.cancelled)} / {faNum(r.noShow)}
                  </TableCell>
                  <TableCell className="num hidden whitespace-nowrap text-xs sm:table-cell">{rial(r.valueRial)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

export default function ManagementReports({ from, to }: { from: string; to: string }) {
  const { data, error, loading, reload } = useLoad(async () => (await reportsAdvanced({ from, to })) as Data, [from, to]);
  if (loading) return <LoadingBlock rows={6} />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;

  const tot = data.daily.reduce(
    (a, d) => ({
      reserved: a.reserved + d.reserved,
      delivered: a.delivered + d.delivered,
      cancelled: a.cancelled + d.cancelled,
      noShow: a.noShow + d.noShow,
      value: a.value + d.valueRial,
    }),
    { reserved: 0, delivered: 0, cancelled: 0, noShow: 0, value: 0 },
  );
  const credits = data.ledger.filter((l) => l.amountRial > 0).reduce((a, l) => a + l.amountRial, 0);
  const debits = -data.ledger.filter((l) => l.amountRial < 0).reduce((a, l) => a + l.amountRial, 0);

  const exportAll = () =>
    downloadCsv(
      `management-${from}-${to}.csv`,
      ['بخش', 'عنوان', 'رزرو/تعداد', 'تحویل', 'لغو', 'عدم مراجعه', 'مبلغ (ریال)'],
      [
        ...data.daily.map((d) => ['روزانه', d.date, d.reserved, d.delivered, d.cancelled, d.noShow, d.valueRial]),
        ...data.ledger.map((l) => ['مالی', LEDGER_TYPES[l.type] ?? l.type, l.count, '', '', '', l.amountRial]),
        ...data.faculty.map((g) => ['دانشکده', g.key, g.reserved, g.delivered, g.cancelled, g.noShow, g.valueRial]),
        ...data.foods.map((g) => ['غذا', g.key, g.reserved, g.delivered, g.cancelled, g.noShow, g.valueRial]),
        ...data.byCustomerGroup.map((g) => [
          'گروه مشتری',
          GROUP_LABELS[g.key] ?? g.key,
          g.reserved,
          g.delivered,
          g.cancelled,
          g.noShow,
          g.valueRial,
        ]),
      ],
    );

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={exportAll}>
          <Download className="ms-1 h-4 w-4" />
          خروجی کامل گزارش مدیریتی
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard tone="primary" label="ارزش رزروها" value={rial(tot.value)} hint={`در ${faNum(data.daily.length)} روز سرویس`} />
        <StatCard
          label="رزرو / تحویل"
          value={`${faNum(tot.reserved)} / ${faNum(tot.delivered)}`}
          hint={`نرخ مراجعه ${pct(tot.delivered, tot.delivered + tot.noShow)}`}
        />
        <StatCard label="لغو / عدم مراجعه" value={`${faNum(tot.cancelled)} / ${faNum(tot.noShow)}`} hint="ثبت‌شده به‌صورت مجزا" />
        <StatCard
          label="وضعیت دانشجویان"
          value={faNum(data.students.total)}
          hint={`فعال ${faNum(data.students.active)} · مرخصی ${faNum(data.students.onLeave)} · حذف ${faNum(data.students.removed)}`}
        />
        <StatCard label="افزایش اعتبار دفتر کل" value={rial(credits)} />
        <StatCard label="کسر اعتبار دفتر کل" value={rial(debits)} />
        <StatCard
          label="مانده‌ی اعتبار بازپرداخت‌ها"
          value={rial(data.wallets.totalRial)}
          hint={`${faNum(data.wallets.positive)} حساب دارای مانده از ${faNum(data.wallets.accounts)} حساب فعال`}
        />
        <StatCard label="سقف مانده‌ی تکی" value={rial(data.wallets.maxRial)} />
      </div>

      <Section title="روند روزانه‌ی رزرو، تحویل، لغو و عدم مراجعه">
        <div className="h-64 w-full" dir="ltr">
          <ResponsiveContainer>
            <AreaChart data={data.daily.map((d) => ({ ...d, label: faShort(d.date) }))} margin={{ left: -10, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="reserved" name="رزرو" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1) / 0.2)" strokeWidth={2} />
              <Area type="monotone" dataKey="delivered" name="تحویل" stroke="hsl(var(--chart-2))" fill="hsl(var(--chart-2) / 0.2)" strokeWidth={2} />
              <Area type="monotone" dataKey="cancelled" name="لغو" stroke="hsl(var(--chart-5))" fill="hsl(var(--chart-5) / 0.1)" strokeWidth={1.5} />
              <Area type="monotone" dataKey="noShow" name="عدم مراجعه" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive) / 0.1)" strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <Section title="تفکیک تراکنش‌های دفتر کل">
        {!data.ledger.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">تراکنشی در این بازه نیست</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">نوع</TableHead>
                <TableHead className="text-right">تعداد</TableHead>
                <TableHead className="text-right">جمع مبلغ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.ledger.map((l) => (
                <TableRow key={l.type}>
                  <TableCell>{LEDGER_TYPES[l.type] ?? l.type}</TableCell>
                  <TableCell className="num">{faNum(l.count)}</TableCell>
                  <TableCell className={`num whitespace-nowrap ${l.amountRial < 0 ? 'text-destructive' : 'text-[hsl(var(--success))]'}`}>
                    {rial(l.amountRial)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell>خالص تغییر مانده</TableCell>
                <TableCell />
                <TableCell className="num whitespace-nowrap">{rial(credits - debits)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <GroupTable title="مصرف به تفکیک دانشکده" rows={data.faculty} file="by-faculty.csv" showStudents />
        <GroupTable title="پرطرفدارترین غذاها" rows={data.foods} file="top-foods.csv" />
        <GroupTable title="مصرف به تفکیک گروه مشتری" rows={data.byCustomerGroup} file="by-group.csv" />
      </div>
    </div>
  );
}
