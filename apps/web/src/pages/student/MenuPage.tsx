import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Clock, MapPin, Plus, ShoppingBag, Users } from 'lucide-react';
import { studentMenu } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import CheckoutSheet from '../../components/Checkout';
import { MEALS, addDays, faDateTime, faNum, faShort, faWeekday, rial, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { MenuOffering } from '../../lib/types';

const ORDER = ['Breakfast', 'Lunch', 'Dinner'];
const MEAL_EMOJI: Record<string, string> = { Breakfast: '🍳', Lunch: '🍛', Dinner: '🍲' };

export default function MenuPage() {
  const today = tehranToday();
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(today, i)), [today]);
  const [day, setDay] = useState(today);
  const [meal, setMeal] = useState<string>('all');
  const { data, error, loading, reload } = useLoad(async () => (await studentMenu({ from: days[0], to: days[13] })) as { offerings: MenuOffering[] });
  const [cart, setCart] = useState<MenuOffering[]>([]);
  const [checkout, setCheckout] = useState(false);
  const all = data?.offerings ?? [];
  const list = all.filter((o) => o.serviceDate === day && (meal === 'all' || o.mealSlot === meal)).sort((a, b) => ORDER.indexOf(a.mealSlot) - ORDER.indexOf(b.mealSlot));
  const total = cart.reduce((s, o) => s + o.priceRial, 0);
  const toggle = (o: MenuOffering) => setCart((c) => c.some((x) => x.id === o.id) ? c.filter((x) => x.id !== o.id)
    : [...c, o]);

  return (
    <>
      <PageHeader title="منوی غذا" subtitle="غذاهای دلخواه را به سبد اضافه کنید و یکجا پرداخت کنید" />
      <div className="sticky top-16 z-10 -mx-4 mb-4 space-y-3 bg-background/85 px-4 pb-3 pt-1 backdrop-blur-xl sm:-mx-6 sm:px-6">
        <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6" role="tablist" aria-label="انتخاب روز">
          {days.map((d) => {
            const count = all.filter((o) => o.serviceDate === d).length;
            const inCart = cart.some((o) => o.serviceDate === d);
            return (
              <button key={d} role="tab" aria-selected={d === day} onClick={() => setDay(d)}
                className={cn('relative flex min-w-[64px] snap-start flex-col items-center rounded-2xl border px-2 py-2 text-sm transition-all active:scale-95', d === day ? 'border-primary bg-primary text-primary-foreground shadow-[var(--shadow-md)]' : 'bg-card', !count && d !== day && 'opacity-50')}>
                <span className="text-[11px] opacity-80">{d === today ? 'امروز' : faWeekday(d)}</span>
                <span className="font-bold">{faShort(d)}</span>
                <span className={cn('mt-1 h-1.5 w-1.5 rounded-full', count ? (d === day ? 'bg-[hsl(var(--sidebar-primary))]' : 'bg-primary') : 'bg-transparent')} />
                {inCart && <span className="absolute -left-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-[hsl(var(--warning))] text-white"><Check className="h-2.5 w-2.5" /></span>}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2">
          {['all', ...ORDER].map((m) => (
            <button key={m} onClick={() => setMeal(m)} className={cn('h-9 rounded-full border px-3.5 text-xs font-medium transition active:scale-95', meal === m ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground')}>
              {m === 'all' ? 'همه' : `${MEAL_EMOJI[m]} ${MEALS[m]}`}
            </button>
          ))}
        </div>
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : list.length === 0 ? (
        <EmptyState title="غذایی برای این روز تعریف نشده" text="روز یا وعده‌ی دیگری را انتخاب کنید." />
      ) : (
        <div className="stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((o) => <OfferingCard key={o.id} o={o} inCart={cart.some((x) => x.id === o.id)} onToggle={() => toggle(o)} />)}
        </div>
      )}
      <AnimatePresence>
        {cart.length > 0 && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 34 }}
            className="fixed inset-x-3 bottom-[5.6rem] z-30 lg:bottom-6 lg:left-6 lg:right-auto lg:w-96">
            <button onClick={() => setCheckout(true)} className="hero-surface flex w-full items-center gap-3 rounded-2xl p-3 text-right text-white shadow-[var(--shadow-xl)] active:scale-[0.98]">
              <span className="relative grid h-11 w-11 place-items-center rounded-xl bg-white/15"><ShoppingBag className="h-5 w-5" />
                <span className="absolute -left-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-[hsl(var(--sidebar-primary))] px-1 text-[11px] font-bold text-[hsl(var(--sidebar-primary-foreground))]">{faNum(cart.length)}</span></span>
              <span className="flex-1"><span className="block text-xs text-white/70">جمع فاکتور</span><span className="num font-extrabold">{rial(total)}</span></span>
              <span className="rounded-xl bg-[hsl(var(--sidebar-primary))] px-4 py-2.5 text-sm font-bold text-[hsl(var(--sidebar-primary-foreground))]">پرداخت</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <CheckoutSheet open={checkout} onOpenChange={setCheckout} cart={cart} onRemove={(id) => setCart((c) => c.filter((x) => x.id !== id))} onPaid={() => { setCart([]); reload(); }} />
    </>
  );
}

function OfferingCard({ o, inCart, onToggle }: { o: MenuOffering; inCart: boolean; onToggle: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const full = o.remaining <= 0;
  const pct = o.capacity ? Math.round(((o.capacity - o.remaining) / o.capacity) * 100) : 0;
  let action: React.ReactNode;
  if (o.myStatus) action = <Pill tone={o.myStatus === 'Delivered' ? 'success' : 'info'}>{o.myStatus === 'Delivered' ? 'تحویل شده' : 'رزرو شده ✓'}</Pill>;
  else if (!o.open) action = <Pill tone="muted">مهلت تمام شده</Pill>;
  else if (full) action = <Pill tone="danger">ظرفیت تکمیل</Pill>;
  else action = (
    <Button size="sm" onClick={onToggle} variant={inCart ? 'outline' : 'default'} className={cn('h-11 rounded-xl px-4 transition-all', inCart && 'border-primary text-primary')}>
      {inCart ? <><Check className="ms-1 h-4 w-4" />در سبد</> : <><Plus className="ms-1 h-4 w-4" />افزودن</>}
    </Button>
  );
  return (
    <article className={cn('lift flex flex-col rounded-2xl border bg-card p-4 shadow-[var(--shadow-sm)] transition-colors', inCart && 'border-primary ring-2 ring-primary/15')}>
      <div className="flex items-start gap-3">
        {o.imagePath && !imgFailed ? (
          <img
            src={o.imagePath}
            alt={o.foodName}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-16 w-16 shrink-0 rounded-2xl border object-cover"
          />
        ) : (
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-accent text-2xl">{MEAL_EMOJI[o.mealSlot] ?? '🍽️'}</span>
        )}
        <div className="min-w-0 flex-1">
          <span className="text-[11px] font-semibold text-primary">{MEALS[o.mealSlot]}</span>
          <h3 className="truncate text-base font-bold">{o.foodName}</h3>
          {o.foodDescription && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{o.foodDescription}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{o.cafeteriaName}</span>
        <span className="flex items-center gap-1"><Clock className="h-3 w-3" />تا {faDateTime(o.reserveDeadline)}</span>
        <span className="flex items-center gap-1"><Users className="h-3 w-3" />{faNum(o.remaining)} باقی‌مانده</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', pct > 90 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} /></div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="num text-lg font-extrabold">{rial(o.priceRial)}</span>
        {action}
      </div>
    </article>
  );
}
