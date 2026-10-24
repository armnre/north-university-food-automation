import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, MapPin, QrCode, Ticket } from 'lucide-react';
import { studentReservations } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import QrDialog, { type QrTarget } from '../../components/QrDialog';
import { MEALS, RES_STATUS, faDate, faDateTime, rial, showCode, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { MyReservations as Data, MyReservation } from '../../lib/types';

const EMOJI: Record<string, string> = { Breakfast: '🍳', Lunch: '🍛', Dinner: '🍲' };

export default function MyReservations() {
  const { data, error, loading, reload } = useLoad(async (t) => (await studentReservations({ token: t })) as Data);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [qr, setQr] = useState<QrTarget | null>(null);
  const today = tehranToday();
  const all = data?.reservations ?? [];
  const rows = all.filter((r) => (tab === 'upcoming' ? r.status === 'Reserved' : r.status !== 'Reserved'))
    .sort((a, b) => (tab === 'upcoming' ? 1 : -1) * a.serviceDate.localeCompare(b.serviceDate));
  const todays = all.filter((r) => r.status === 'Reserved' && r.serviceDate === today && r.qrToken);
  const open = (r: MyReservation) => r.qrToken && setQr({ ...r, qrToken: r.qrToken });
  return (
    <>
      <PageHeader title="بلیط‌های من" subtitle="روی هر بلیط بزنید تا کیو‌آر و کد تحویل نمایش داده شود" />
      {todays.length > 0 && (
        <div className="mb-5 space-y-2">
          {todays.map((r) => (
            <button key={r.id} onClick={() => open(r)} className="hero-surface relative flex w-full items-center gap-4 overflow-hidden rounded-3xl p-4 text-right text-white shadow-[var(--shadow-lg)] active:scale-[0.98]">
              <div className="dot-grid pointer-events-none absolute inset-0 opacity-30" />
              <span className="relative grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-white text-primary"><QrCode className="h-9 w-9" /></span>
              <span className="relative min-w-0 flex-1">
                <span className="block text-xs text-[hsl(var(--sidebar-primary))]">بلیط امروز · {MEALS[r.mealType]}</span>
                <span className="block truncate text-lg font-extrabold">{r.foodName}</span>
                <span className="block font-mono text-xs tracking-widest text-white/70" dir="ltr">{showCode(r.code)}</span>
              </span>
              <span className="relative rounded-xl bg-[hsl(var(--sidebar-primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--sidebar-primary-foreground))]">نمایش</span>
            </button>
          ))}
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1 sm:inline-grid sm:w-72">
        {(['upcoming', 'past'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn('h-10 rounded-xl text-sm font-medium transition', tab === t ? 'bg-card text-foreground shadow-[var(--shadow-sm)]' : 'text-muted-foreground')}>
            {t === 'upcoming' ? 'فعال' : 'سوابق'}
          </button>
        ))}
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState title={tab === 'upcoming' ? 'بلیط فعالی ندارید' : 'سابقه‌ای ثبت نشده است'} action={tab === 'upcoming' ? <Button asChild><Link to="/menu">رفتن به منو</Link></Button> : undefined} />
      ) : (
        <div className="stagger grid gap-3 md:grid-cols-2">
          {rows.map((r) => {
            const active = r.status === 'Reserved' && !!r.qrToken;
            return (
              <button key={r.id} disabled={!active} onClick={() => open(r)} className={cn('lift flex items-stretch overflow-hidden rounded-2xl border bg-card text-right shadow-[var(--shadow-sm)]', !active && 'cursor-default opacity-80')}>
                <span className="grid w-16 shrink-0 place-items-center bg-accent text-2xl">{EMOJI[r.mealType] ?? '🍽️'}</span>
                <span className="relative w-0 border-r-2 border-dashed border-border" />
                <span className="min-w-0 flex-1 p-3.5">
                  <span className="flex items-center gap-2"><span className="truncate font-bold">{r.foodName}</span><Pill tone={RES_STATUS[r.status]?.tone ?? 'muted'}>{RES_STATUS[r.status]?.label ?? r.status}</Pill></span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{MEALS[r.mealType]} · {faDate(r.serviceDate)}</span>
                  <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="h-3 w-3" />{r.cafeteriaName} · <span className="num">{rial(r.priceAtBooking)}</span></span>
                  {r.deliveredAt && <span className="mt-0.5 block text-xs text-[hsl(var(--success))]">تحویل: {faDateTime(r.deliveredAt)}</span>}
                </span>
                {active && <span className="flex flex-col items-center justify-center gap-1 px-3 text-primary"><Ticket className="h-5 w-5" /><span className="text-[10px] font-bold">بلیط</span><ChevronLeft className="h-3.5 w-3.5" /></span>}
              </button>
            );
          })}
        </div>
      )}
      <QrDialog target={qr} onClose={() => setQr(null)} />
    </>
  );
}
