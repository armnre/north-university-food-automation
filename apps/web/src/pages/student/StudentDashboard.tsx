import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, QrCode, UtensilsCrossed, Wallet as WalletIcon } from 'lucide-react';
import { studentReservations, studentWallet } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { ErrorState, LoadingBlock, Pill, Section, StatCard, EmptyState } from '../../components/ui-kit';
import QrDialog, { type QrTarget } from '../../components/QrDialog';
import { MEALS, RES_STATUS, faDate, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { StudentMe } from '../../lib/session';
import type { MyReservations, Wallet } from '../../lib/types';

export default function StudentDashboard({ me }: { me: StudentMe }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [w, r] = await Promise.all([studentWallet(), studentReservations()]);
    return { w: w as Wallet, r: r as MyReservations };
  });
  const [qr, setQr] = useState<QrTarget | null>(null);
  if (loading) return <LoadingBlock />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  const upcoming = data.r.reservations.filter((x) => x.status === 'Reserved').sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
  const todays = upcoming.filter((x) => x.serviceDate === data.r.today);
  return (
    <div className="stagger space-y-6">
      <div className="hero-surface relative overflow-hidden rounded-3xl p-5 text-primary-foreground shadow-[var(--shadow-md)] sm:p-7">
        <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="absolute -left-10 -top-10 h-40 w-40 rounded-full bg-[hsl(var(--sidebar-primary)/0.25)] blur-2xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-primary-foreground/75">{faDate(data.r.today)}</p>
            <h1 className="mt-1 text-2xl font-extrabold sm:text-3xl">سلام، {me.fullName.split(' ')[0] || 'دانشجوی گرامی'} 👋</h1>
          </div>
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/10 text-[hsl(var(--sidebar-primary))]"><WalletIcon className="h-5 w-5" /></span>
        </div>
        <div className="relative mt-6">
          <p className="text-xs text-primary-foreground/70">موجودی کیف پول</p>
          <p className="num mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">{rial(data.w.balanceRial)}</p>
        </div>
        <div className="relative mt-5 grid grid-cols-2 gap-2 sm:flex">
          <Button asChild className="h-11 rounded-xl bg-[hsl(var(--sidebar-primary))] font-semibold text-[hsl(var(--sidebar-primary-foreground))] hover:bg-[hsl(var(--sidebar-primary)/0.9)]"><Link to="/menu"><CalendarDays className="ms-1 h-4 w-4" />رزرو غذا</Link></Button>
          <Button asChild variant="ghost" className="h-11 rounded-xl bg-white/10 text-white hover:bg-white/20 hover:text-white"><Link to="/wallet">تراکنش‌ها</Link></Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <StatCard label="رزروهای پیش رو" value={faNum(upcoming.length)} icon={<CalendarDays className="h-4 w-4" />} />
        <StatCard label="تحویل‌شده" value={faNum(data.r.reservations.filter((x) => x.status === 'Delivered').length)} icon={<UtensilsCrossed className="h-4 w-4" />} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="غذای امروز">
          {todays.length === 0 ? <EmptyState title="برای امروز رزروی ندارید" action={<Button variant="outline" asChild><Link to="/menu">مشاهده‌ی منو</Link></Button>} /> : (
            <div className="space-y-3">
              {todays.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-2xl border bg-gradient-to-l from-accent/60 to-transparent p-3.5">
                  <div className="min-w-0"><div className="truncate font-bold">{r.foodName}</div><div className="text-sm text-muted-foreground">{MEALS[r.mealSlot]} · {r.cafeteriaName}</div></div>
                  {r.qrToken && <Button size="sm" className="h-10 shrink-0 rounded-xl" onClick={() => setQr({ ...r, qrToken: r.qrToken! })}><QrCode className="ms-1 h-4 w-4" />QR</Button>}
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="رزروهای پیش رو" actions={<Link to="/reservations" className="flex items-center gap-1 text-sm font-medium text-primary">همه<ArrowLeft className="h-4 w-4" /></Link>}>
          {upcoming.length === 0 ? <p className="text-sm text-muted-foreground">رزرو فعالی ندارید.</p> : (
            <ul className="space-y-2">
              {upcoming.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-sm">
                  <span className="min-w-0"><span className="block truncate font-semibold">{r.foodName}</span><span className="text-xs text-muted-foreground">{MEALS[r.mealSlot]} · {faDate(r.serviceDate)}</span></span>
                  <Pill tone={RES_STATUS[r.status].tone}>{RES_STATUS[r.status].label}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <QrDialog target={qr} onClose={() => setQr(null)} />
    </div>
  );
}
