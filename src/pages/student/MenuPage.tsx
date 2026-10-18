import { useMemo, useRef, useState } from 'react';
import { Clock, Loader2, MapPin, Users } from 'lucide-react';
import { toast } from 'sonner';
import { studentMenu, studentReserve } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { MEALS, addDays, errMsg, faDateTime, faNum, faShort, faWeekday, newKey, rial, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { MenuOffering } from '../../lib/types';

const ORDER = ['Breakfast', 'Lunch', 'Dinner'];

export default function MenuPage() {
  const today = tehranToday();
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(today, i)), [today]);
  const [day, setDay] = useState(today);
  const { data, error, loading, reload } = useLoad(async (token) => (await studentMenu({ token, from: days[0], to: days[13] })) as { offerings: MenuOffering[] });
  const [pick, setPick] = useState<MenuOffering | null>(null);
  const list = (data?.offerings ?? []).filter((o) => o.serviceDate === day).sort((a, b) => ORDER.indexOf(a.mealType) - ORDER.indexOf(b.mealType));
  return (
    <>
      <PageHeader title="منوی غذا" subtitle="روز موردنظر را انتخاب و غذای خود را رزرو کنید. همه‌ی مبالغ به ریال است." />
      <div className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-2" role="tablist" aria-label="انتخاب روز">
        {days.map((d) => {
          const count = (data?.offerings ?? []).filter((o) => o.serviceDate === d).length;
          return (
            <button key={d} role="tab" aria-selected={d === day} onClick={() => setDay(d)}
              className={cn('flex min-w-[72px] flex-col items-center rounded-xl border px-3 py-2 text-sm transition', d === day ? 'border-primary bg-primary text-primary-foreground shadow-[var(--shadow-md)]' : 'bg-card hover:border-primary/40')}>
              <span className="text-xs opacity-80">{d === today ? 'امروز' : faWeekday(d)}</span>
              <span className="font-bold">{faShort(d)}</span>
              <span className={cn('mt-1 h-1.5 w-1.5 rounded-full', count ? (d === day ? 'bg-[hsl(var(--sidebar-primary))]' : 'bg-primary') : 'bg-transparent')} />
            </button>
          );
        })}
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : list.length === 0 ? (
        <EmptyState title="برای این روز غذایی تعریف نشده است" text="روز دیگری را انتخاب کنید یا بعداً سر بزنید." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((o) => <OfferingCard key={o.id} o={o} onPick={() => setPick(o)} />)}
        </div>
      )}
      <ReserveDialog offering={pick} onClose={() => setPick(null)} onDone={reload} />
    </>
  );
}

function OfferingCard({ o, onPick }: { o: MenuOffering; onPick: () => void }) {
  const full = o.remaining <= 0;
  const pct = o.capacity ? Math.round(((o.capacity - o.remaining) / o.capacity) * 100) : 0;
  let action: React.ReactNode;
  if (o.myStatus) action = <Pill tone={o.myStatus === 'Delivered' ? 'success' : 'info'}>{o.myStatus === 'Delivered' ? 'تحویل شده' : 'رزرو شما'}</Pill>;
  else if (o.slotTaken) action = <span className="text-xs text-muted-foreground">برای این وعده رزرو دیگری دارید</span>;
  else if (!o.open) action = <Pill tone="muted">مهلت رزرو تمام شده</Pill>;
  else if (full) action = <Pill tone="danger">ظرفیت تکمیل</Pill>;
  else action = <Button size="sm" onClick={onPick}>جزئیات و رزرو</Button>;
  return (
    <article className="flex flex-col rounded-xl border bg-card p-4 shadow-[var(--shadow-sm)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-xs font-medium text-primary">{MEALS[o.mealType]}</span>
          <h3 className="mt-0.5 text-lg font-bold">{o.foodName}</h3>
        </div>
        <div className="num text-left font-bold">{rial(o.priceRial)}</div>
      </div>
      {o.foodDescription && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{o.foodDescription}</p>}
      <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{o.cafeteriaName}</div>
        <div className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />مهلت رزرو: {faDateTime(o.reserveDeadline)}</div>
        <div className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />باقی‌مانده: {faNum(o.remaining)} از {faNum(o.capacity)}</div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', pct > 90 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>
      <div className="mt-4 flex items-center justify-end">{action}</div>
    </article>
  );
}

function ReserveDialog({ offering, onClose, onDone }: { offering: MenuOffering | null; onClose: () => void; onDone: () => void }) {
  const { token } = useSession();
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string>('');
  if (offering && !keyRef.current) keyRef.current = newKey(); // same key across retries of this attempt
  const close = () => { keyRef.current = ''; onClose(); };
  const confirm = async () => {
    if (!offering) return;
    setBusy(true);
    try {
      const r = await studentReserve({ token, offeringId: offering.id, idempotencyKey: keyRef.current });
      toast.success(`رزرو با موفقیت ثبت شد. کد رزرو: ${r.code}`);
      close(); onDone();
    } catch (e) { toast.error(errMsg(e)); onDone(); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={!!offering} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent dir="rtl">
        {offering && (
          <>
            <DialogHeader>
              <DialogTitle>{offering.foodName}</DialogTitle>
              <DialogDescription>{MEALS[offering.mealType]} · {offering.cafeteriaName}</DialogDescription>
            </DialogHeader>
            {offering.foodDescription && <p className="text-sm">{offering.foodDescription}</p>}
            {offering.notes && <p className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">{offering.notes}</p>}
            <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
              <dt className="text-muted-foreground">مبلغ قابل کسر</dt><dd className="num font-bold">{rial(offering.priceRial)}</dd>
              <dt className="text-muted-foreground">ظرفیت باقی‌مانده</dt><dd className="num">{faNum(offering.remaining)}</dd>
              <dt className="text-muted-foreground">مهلت رزرو</dt><dd>{faDateTime(offering.reserveDeadline)}</dd>
              <dt className="text-muted-foreground">مهلت لغو</dt><dd>{faDateTime(offering.cancelDeadline)}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">با تأیید، مبلغ از کیف پول شما کسر می‌شود. در صورت لغو پیش از مهلت لغو، همین مبلغ به کیف پول برمی‌گردد.</p>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={close} disabled={busy}>انصراف</Button>
              <Button onClick={confirm} disabled={busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}تأیید و رزرو</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
