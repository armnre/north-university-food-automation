import { Link } from 'react-router-dom';
import { AlertTriangle, Activity, CheckCircle2, GraduationCap, Utensils, XCircle } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { adminDashboard } from '../../lib/api';
import { ErrorState, LoadingBlock, PageHeader, Section, StatCard, Pill } from '../../components/ui-kit';
import { MEALS, faDate, faDateTime, faNum, faShort, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type Kpis = { activeStudents: number; totalStudents: number; activeEmployees: number; todayCapacity: number; todayReserved: number; todayDelivered: number; todayCancelled: number; todayValueRial: number; needsReview: number; offlineConflicts: number };
type Dash = {
  today: string; kpis: Kpis;
  trend: { date: string; reserved: number; delivered: number; noShow: number }[]; byMeal: { meal: string; capacity: number; reserved: number }[];
  lastImport: { fileName: string; status: string; totalRows: number; errorRows: number; newRows: number; updatedRows: number; createdAt: string } | null;
  money: { credits: number; debits: number; refunds: number; liability: number } | null;
};

export default function AdminDashboard() {
  const { me } = useSession();
  const perms = me?.kind === 'staff' ? me.staff.perms : [];
  const { data, error, loading, reload } = useLoad(async (token) => (await adminDashboard({ token })) as Dash);
  if (loading) return <LoadingBlock rows={5} />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  const k = data.kpis;
  const trend = data.trend.map((t) => ({ ...t, label: faShort(t.date) }));
  return (
    <>
      <PageHeader title="داشبورد مدیریتی" subtitle={faDate(data.today)} />
      {(k.needsReview > 0 || k.offlineConflicts > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          {k.needsReview > 0 && <span>{faNum(k.needsReview)} پرداخت نیازمند بررسی {perms.includes('paymentsReview') && <Link to="/payments-review" className="font-semibold text-primary underline">بررسی</Link>}</span>}
          {k.offlineConflicts > 0 && <span>{faNum(k.offlineConflicts)} تعارض تحویل آفلاین در ۷ روز گذشته</span>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="دانشجویان فعال" value={faNum(k.activeStudents)} hint={`از ${faNum(k.totalStudents)}`} icon={<GraduationCap className="h-5 w-5" />} />
        <StatCard label="رزرو امروز" value={faNum(k.todayReserved)} hint={`ظرفیت ${faNum(k.todayCapacity)}`} icon={<Utensils className="h-5 w-5" />} />
        <StatCard label="ظرفیت باقی‌مانده" value={faNum(Math.max(0, k.todayCapacity - k.todayReserved))} icon={<Activity className="h-5 w-5" />} />
        <StatCard label="تحویل‌شده امروز" value={faNum(k.todayDelivered)} icon={<CheckCircle2 className="h-5 w-5" />} />
        <StatCard label="لغو امروز" value={faNum(k.todayCancelled)} icon={<XCircle className="h-5 w-5" />} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Section title="روند رزرو، تحویل و عدم مراجعه" className="lg:col-span-2">
          {trend.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">هنوز داده‌ای برای نمایش وجود ندارد.</p> : (
            <div className="h-72" dir="ltr">
              <ResponsiveContainer>
                <BarChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" reversed tick={{ fontSize: 11 }} />
                  <YAxis orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontFamily: 'Vazirmatn', direction: 'rtl' }} />
                  <Legend wrapperStyle={{ fontFamily: 'Vazirmatn' }} />
                  <Bar dataKey="reserved" name="رزرو" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="delivered" name="تحویل" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="noShow" name="عدم مراجعه" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>
        <Section title="وعده‌های امروز">
          {data.byMeal.length === 0 ? <p className="text-sm text-muted-foreground">برای امروز وعده‌ای تعریف نشده است.</p> : (
            <ul className="space-y-4">
              {data.byMeal.map((m) => {
                const pct = m.capacity ? Math.round((m.reserved / m.capacity) * 100) : 0;
                return (
                  <li key={m.meal}>
                    <div className="flex justify-between text-sm"><span className="font-medium">{MEALS[m.meal] ?? m.meal}</span><span className="num text-muted-foreground">{faNum(m.reserved)} / {faNum(m.capacity)}</span></div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {data.money && (
          <Section title="وضعیت مالی (از دفترکل)">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-muted-foreground">شارژهای دستی</dt><dd className="num mt-1 font-bold">{rial(data.money.credits)}</dd></div>
              <div><dt className="text-muted-foreground">کسر بابت رزرو</dt><dd className="num mt-1 font-bold">{rial(data.money.debits)}</dd></div>
              <div><dt className="text-muted-foreground">بازپرداخت‌ها</dt><dd className="num mt-1 font-bold">{rial(data.money.refunds)}</dd></div>
              <div><dt className="text-muted-foreground">مجموع موجودی کیف پول‌ها</dt><dd className="num mt-1 font-bold">{rial(data.money.liability)}</dd></div>
            </dl>
          </Section>
        )}
        <Section title="آخرین واردسازی دانشجویان">
          {!data.lastImport ? <p className="text-sm text-muted-foreground">هنوز واردسازی انجام نشده است.</p> : (
            <div className="text-sm">
              <div className="flex items-center justify-between"><span className="font-medium">{data.lastImport.fileName}</span><Pill tone={data.lastImport.status === 'Committed' ? 'success' : data.lastImport.status === 'Undone' ? 'warning' : 'muted'}>{({ Committed: 'ثبت‌شده', Previewed: 'پیش‌نمایش', Committing: 'در حال ثبت', Cancelled: 'لغوشده', Undone: 'بازگردانی‌شده' } as Record<string, string>)[data.lastImport.status] ?? data.lastImport.status}</Pill></div>
              <div className="mt-2 text-muted-foreground">{faDateTime(data.lastImport.createdAt)} · {faNum(data.lastImport.totalRows)} ردیف · {faNum(data.lastImport.newRows)} جدید · {faNum(data.lastImport.updatedRows)} به‌روزرسانی · {faNum(data.lastImport.errorRows)} خطا</div>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
