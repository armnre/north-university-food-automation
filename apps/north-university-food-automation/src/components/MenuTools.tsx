import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Copy, Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { offeringsBulk } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { ErrorNote } from './ui-kit';
import { MEALS, addDays, errMsg, faDate, faNum, rial, tehranLocalToIso } from '../lib/format';
import type { Catalog } from '../lib/types';

type Line = { key: string; mealType: string; foodId: string; priceRial: string; capacity: string };
const MEAL_KEYS = ['Breakfast', 'Lunch', 'Dinner'];
const MEAL_EMOJI: Record<string, string> = { Breakfast: '🍳', Lunch: '🍛', Dinner: '🍲' };

/** Build an entire day's menu (all meals) from the food library in one save. */
export function DayMenuBuilder({ open, onClose, onDone, token, catalog, initialDate }: { open: boolean; onClose: () => void; onDone: () => void; token: string; catalog: Catalog; initialDate: string }) {
  const foods = catalog.foods.filter((f) => f.active);
  const [date, setDate] = useState(initialDate);
  const [days, setDays] = useState(1);
  const [meal, setMeal] = useState('Lunch');
  const [lines, setLines] = useState<Line[]>([]);
  const [reserveTime, setReserveTime] = useState('20:00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setDate(initialDate); setLines([]); setErr(''); setDays(1); setMeal('Lunch'); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (foodId: string) => {
    const k = `${meal}-${foodId}`;
    if (lines.some((l) => l.key === k)) return setLines(lines.filter((l) => l.key !== k));
    const f = foods.find((x) => x.id === foodId); if (!f) return;
    setLines([...lines, { key: k, mealType: meal, foodId, priceRial: f.defaultPriceRial != null ? String(f.defaultPriceRial) : '', capacity: f.defaultCapacity != null ? String(f.defaultCapacity) : '100' }]);
  };
  const upd = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const invalid = !lines.length ? 'حداقل یک غذا انتخاب کنید' : lines.some((l) => !/^\d+$/.test(l.priceRial) || !/^\d+$/.test(l.capacity) || Number(l.capacity) < 1) ? 'قیمت و ظرفیت غذاهای انتخابی را کامل کنید' : '';
  const options = foods.filter((f) => (f.suitableMeals.length ? f.suitableMeals.includes(meal) : true));
  const mine = lines.filter((l) => l.mealType === meal);

  const save = async () => {
    if (invalid) return;
    setBusy(true); setErr('');
    try {
      const items = Array.from({ length: days }).flatMap((_, i) => {
        const d = addDays(date, i), prev = addDays(d, -1);
        return lines.map((l) => ({ serviceDate: d, mealType: l.mealType as 'Lunch', foodId: l.foodId, priceRial: Number(l.priceRial), capacity: Number(l.capacity), reserveDeadline: tehranLocalToIso(`${prev}T${reserveTime}`), notes: '' }));
      });
      const r = await offeringsBulk({ token, mode: 'items', items });
      toast.success(`${faNum(r.created)} وعده ساخته شد${r.skipped ? ` · ${faNum(r.skipped)} مورد تکراری رد شد` : ''}.`);
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl" className="flex h-[100dvh] max-h-[100dvh] max-w-full flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-3xl">
        <DialogHeader className="border-b px-5 pb-3 pt-5 text-right"><DialogTitle className="flex items-center gap-2 text-lg"><CalendarPlus className="h-5 w-5 text-primary" />چیدن منوی روز</DialogTitle><DialogDescription>روی غذاها بزنید تا به منو اضافه شوند.</DialogDescription></DialogHeader>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>تاریخ</Label><Input className="h-11 rounded-xl" type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} /><p className="text-[11px] text-muted-foreground">{faDate(date)}{days > 1 && ` تا ${faDate(addDays(date, days - 1))}`}</p></div>
            <div className="space-y-1.5"><Label>تکرار برای</Label>
              <div className="flex h-11 items-center justify-between rounded-xl border bg-card px-1">
                <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setDays(Math.min(days + 1, 14))}><Plus className="h-4 w-4" /></Button>
                <span className="text-sm font-bold">{faNum(days)} روز</span>
                <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setDays(Math.max(days - 1, 1))}><Minus className="h-4 w-4" /></Button>
              </div></div>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1">
            {MEAL_KEYS.map((m) => { const n = lines.filter((l) => l.mealType === m).length; return (
              <button key={m} onClick={() => setMeal(m)} className={cn('relative h-11 rounded-xl text-sm font-medium transition', meal === m ? 'bg-card shadow-[var(--shadow-sm)]' : 'text-muted-foreground')}>
                {MEAL_EMOJI[m]} {MEALS[m]}{n > 0 && <span className="absolute -left-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{faNum(n)}</span>}
              </button>); })}
          </div>
          {options.length === 0 ? <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">غذایی برای این وعده در کتابخانه نیست.</p> : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {options.map((f) => { const on = mine.some((l) => l.foodId === f.id); return (
                <button key={f.id} onClick={() => toggle(f.id)} className={cn('relative flex flex-col items-start rounded-2xl border p-3 text-right transition active:scale-95', on ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : 'bg-card')}>
                  <span className={cn('absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full border', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background')}>{on ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5 text-muted-foreground" />}</span>
                  <span className="line-clamp-1 pl-7 text-sm font-bold">{f.name}</span>
                  <span className="text-[11px] text-muted-foreground">{f.category || 'بدون دسته'}</span>
                  {f.defaultPriceRial != null && <span className="num mt-1 text-xs font-semibold text-primary">{rial(f.defaultPriceRial)}</span>}
                </button>); })}
            </div>
          )}
          {mine.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground">قیمت و ظرفیت {MEALS[meal]}</div>
              {mine.map((l) => (
                <div key={l.key} className="rounded-2xl border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between"><span className="truncate text-sm font-bold">{foods.find((f) => f.id === l.foodId)?.name}</span>
                    <button className="grid h-8 w-8 place-items-center rounded-lg text-destructive hover:bg-destructive/10" aria-label="حذف" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4" /></button></div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><Input className="h-10 rounded-xl" inputMode="numeric" dir="ltr" placeholder="قیمت (ریال)" value={l.priceRial} onChange={(e) => upd(l.key, { priceRial: e.target.value.replace(/\D/g, '') })} />{l.priceRial && <span className="text-[10px] text-muted-foreground">{rial(Number(l.priceRial))}</span>}</div>
                    <Input className="h-10 rounded-xl" inputMode="numeric" dir="ltr" placeholder="ظرفیت" value={l.capacity} onChange={(e) => upd(l.key, { capacity: e.target.value.replace(/\D/g, '') })} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-1.5"><Label>مهلت رزرو (ساعتِ روز قبل)</Label><Input className="h-11 rounded-xl" type="time" dir="ltr" value={reserveTime} onChange={(e) => setReserveTime(e.target.value)} /></div>
          <ErrorNote message={err} onClose={() => setErr('')} />
        </div>
        <div className="flex items-center gap-2 border-t bg-card px-5 py-3 pb-safe">
          <span className="flex-1 text-xs text-muted-foreground">{lines.length ? `${faNum(lines.length * days)} وعده ساخته می‌شود` : invalid}</span>
          <Button variant="outline" className="h-11 rounded-xl" onClick={onClose} disabled={busy}>انصراف</Button>
          <Button className="h-11 rounded-xl px-6 font-bold" onClick={save} disabled={busy || !!invalid}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ثبت منو</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Copy a day/week menu to later dates (optionally repeated several times). */
export function CopyMenuDialog({ open, onClose, onDone, token, weekStart }: { open: boolean; onClose: () => void; onDone: () => void; token: string; weekStart: string }) {
  const [mode, setMode] = useState<'day' | 'week'>('week');
  const [from, setFrom] = useState(weekStart);
  const [target, setTarget] = useState(addDays(weekStart, 7));
  const [repeat, setRepeat] = useState('1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setFrom(weekStart); setTarget(addDays(weekStart, mode === 'week' ? 7 : 1)); setErr(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = mode === 'week' ? addDays(from, 6) : from;
  const run = async () => {
    setBusy(true); setErr('');
    try {
      const r = await offeringsBulk({ token, mode: 'copy', sourceFrom: from, sourceTo: to, targetStart: target, repeat: Math.min(Math.max(Number(repeat) || 1, 1), 12) });
      toast.success(`${faNum(r.created)} وعده کپی شد${r.skipped ? ` · ${faNum(r.skipped)} مورد از قبل وجود داشت` : ''}.`);
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Copy className="h-5 w-5 text-primary" />کپی منو</DialogTitle><DialogDescription>منوی یک روز یا یک هفته را با همان غذا، قیمت و ظرفیت به تاریخ‌های بعدی منتقل کنید.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          {(['day', 'week'] as const).map((m) => <button key={m} onClick={() => { setMode(m); setTarget(addDays(from, m === 'week' ? 7 : 1)); }} className={cn('rounded-md py-1.5 text-sm transition', mode === m ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground')}>{m === 'day' ? 'یک روز' : 'یک هفته'}</button>)}
        </div>
        <div className="grid gap-3">
          <div className="space-y-1.5"><Label>{mode === 'week' ? 'شروع هفته‌ی مبدأ' : 'روز مبدأ'}</Label><Input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /><p className="text-xs text-muted-foreground">{faDate(from)}{mode === 'week' && ` تا ${faDate(to)}`}</p></div>
          <div className="space-y-1.5"><Label>شروع مقصد</Label><Input type="date" dir="ltr" value={target} onChange={(e) => setTarget(e.target.value)} /><p className="text-xs text-muted-foreground">{faDate(target)}</p></div>
          <div className="space-y-1.5"><Label>تعداد تکرار پشت‌سرهم</Label><Input inputMode="numeric" dir="ltr" value={repeat} onChange={(e) => setRepeat(e.target.value.replace(/\D/g, '').slice(0, 2))} /><p className="text-xs text-muted-foreground">مثلاً ۴ = چهار {mode === 'week' ? 'هفته' : 'روز'} متوالی از تاریخ مقصد</p></div>
        </div>
        <ErrorNote message={err} onClose={() => setErr('')} />
        <DialogFooter className="gap-2"><Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button><Button onClick={run} disabled={busy || !from || !target}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}کپی کن</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
