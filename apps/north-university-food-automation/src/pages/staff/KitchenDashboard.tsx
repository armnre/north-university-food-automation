import { Link } from 'react-router-dom';
import { AlertTriangle, BarChart3, BookOpen, CalendarPlus, ChefHat, UtensilsCrossed } from 'lucide-react';
import { offeringsList } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Progress } from '@project/components/ui/progress';
import { cn } from '@project/components/lib/utils';
import { ErrorState, LoadingBlock, PageHeader, Pill, Section, StatCard } from '../../components/ui-kit';
import { MEALS, addDays, faNum, faShort, faWeekday, rial, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { Offering } from '../../lib/types';

const ORDER: Record<string, number> = { Breakfast: 0, Lunch: 1, Dinner: 2 };

export default function KitchenDashboard() {
  const { me } = useSession();
  const today = tehranToday();
  const end = addDays(today, 6);
  const { data, error, loading, reload } = useLoad(async (t) => ((await offeringsList({ token: t, from: today, to: end })) as { offerings: Offering[] }).offerings, []);
  const perms = me?.kind === 'staff' ? me.staff.perms : [];
  if (loading) return <LoadingBlock rows={5} />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;

  const todays = data.filter((o) => o.serviceDate === today && o.active).sort((a, b) => ORDER[a.mealType] - ORDER[b.mealType]);
  const sum = (xs: Offering[], k: 'reserved' | 'delivered' | 'capacity') => xs.reduce((a, o) => a + o[k], 0);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const missing = days.slice(1).filter((d) => !data.some((o) => o.serviceDate === d && o.active));
  const cap = sum(todays, 'capacity'), res = sum(todays, 'reserved'), del = sum(todays, 'delivered');

  return (
    <>
      <PageHeader title="داشبورد آشپزخانه" subtitle="وضعیت امروز، منوی هفت روز آینده و دسترسی سریع به مدیریت غذا و منو"
        actions={<div className="flex flex-wrap gap-2">
          {perms.includes('menu') && <Button asChild><Link to="/offerings"><CalendarPlus className="ms-1 h-4 w-4" />چیدن منو</Link></Button>}
          {perms.includes('foods') && <Button asChild variant="outline"><Link to="/foods"><BookOpen className="ms-1 h-4 w-4" />کتابخانه‌ی غذا</Link></Button>}
          {perms.includes('contractor') && <Button asChild variant="outline"><Link to="/contractor"><BarChart3 className="ms-1 h-4 w-4" />گزارش</Link></Button>}
        </div>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard tone="primary" label="رزرو امروز" value={faNum(res)} hint={`از ظرفیت ${faNum(cap)}`} icon={<ChefHat />} />
        <StatCard label="تحویل‌شده" value={faNum(del)} hint={res ? `${faNum(Math.round((del / res) * 100))}٪ رزروها` : undefined} />
        <StatCard label="در انتظار تحویل" value={faNum(Math.max(res - del, 0))} />
        <StatCard label="ارزش رزرو امروز" value={rial(todays.reduce((a, o) => a + o.reserved * o.priceRial, 0))} />
      </div>

      {missing.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-3 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-[hsl(var(--warning))]" />
          <span className="min-w-0 flex-1">برای {missing.map((d) => faWeekday(d)).join('، ')} هنوز منویی ثبت نشده است.</span>
          {perms.includes('menu') && <Button size="sm" variant="outline" asChild><Link to="/offerings">ثبت منو</Link></Button>}
        </div>
      )}

      <Section className="mt-6" title="منوی امروز">
        {!todays.length ? <p className="py-6 text-center text-sm text-muted-foreground">برای امروز وعده‌ای تعریف نشده است.</p> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {todays.map((o) => {
              const fill = o.capacity ? Math.round((o.reserved / o.capacity) * 100) : 0;
              return (
                <div key={o.id} className="rounded-xl border bg-gradient-to-br from-card to-secondary/30 p-4">
                  <div className="flex items-center justify-between gap-2"><Pill tone="info">{MEALS[o.mealType]}</Pill><span className="text-xs text-muted-foreground">{o.cafeteriaName}</span></div>
                  <p className="mt-2 flex items-center gap-2 font-semibold"><UtensilsCrossed className="h-4 w-4 text-primary" />{o.foodName}</p>
                  <div className="mt-3 flex justify-between text-xs"><span>رزرو {faNum(o.reserved)} از {faNum(o.capacity)}</span><span className="num">{faNum(fill)}٪</span></div>
                  <Progress value={fill} className="mt-1 h-2" />
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-lg bg-card p-2"><div className="num text-base font-bold text-[hsl(var(--success))]">{faNum(o.delivered)}</div>تحویل</div>
                    <div className="rounded-lg bg-card p-2"><div className="num text-base font-bold">{faNum(o.reserved - o.delivered)}</div>منتظر</div>
                    <div className="rounded-lg bg-card p-2"><div className="num text-base font-bold">{faNum(o.remaining)}</div>باقی‌مانده</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section className="mt-6" title="هفت روز آینده">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:grid lg:grid-cols-7">
          {days.map((d) => {
            const xs = data.filter((o) => o.serviceDate === d && o.active);
            const r = sum(xs, 'reserved'), c = sum(xs, 'capacity');
            return (
              <div key={d} className={cn('min-w-[132px] rounded-xl border p-3', d === today && 'border-primary bg-secondary/50', !xs.length && 'border-dashed')}>
                <p className="text-sm font-semibold">{faWeekday(d)}</p>
                <p className="text-xs text-muted-foreground">{faShort(d)}</p>
                {xs.length ? <>
                  <ul className="mt-2 space-y-1 text-xs">{xs.sort((a, b) => ORDER[a.mealType] - ORDER[b.mealType]).slice(0, 4).map((o) => <li key={o.id} className="truncate"><span className="text-muted-foreground">{MEALS[o.mealType]}:</span> {o.foodName}</li>)}</ul>
                  <p className="num mt-2 text-xs font-medium text-primary">{faNum(r)} / {faNum(c)}</p>
                </> : <p className="mt-3 text-xs text-[hsl(var(--warning))]">بدون منو</p>}
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
