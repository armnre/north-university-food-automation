import { useEffect, useState } from 'react';
import { CalendarPlus, Copy, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { offeringsBulk } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { ErrorNote } from './ui-kit';
import { MEALS, addDays, errMsg, faDate, faNum, rial, tehranLocalToIso } from '../lib/format';
import type { Catalog } from '../lib/types';

type Line = { key: string; mealType: string; foodId: string; priceRial: string; capacity: string };
const MEAL_KEYS = ['Breakfast', 'Lunch', 'Dinner'];

/** Build an entire day's menu (all meals) from the food library in one save. */
export function DayMenuBuilder({ open, onClose, onDone, token, catalog, initialDate }: { open: boolean; onClose: () => void; onDone: () => void; token: string; catalog: Catalog; initialDate: string }) {
  const cafs = catalog.cafeterias.filter((c) => c.active);
  const foods = catalog.foods.filter((f) => f.active);
  const [date, setDate] = useState(initialDate);
  const [days, setDays] = useState('1');
  const [caf, setCaf] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [reserveTime, setReserveTime] = useState('20:00');
  const [cancelTime, setCancelTime] = useState('22:00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setDate(initialDate); setCaf(cafs[0]?.id ?? ''); setLines([]); setErr(''); setDays('1'); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (mealType: string, foodId: string) => {
    const f = foods.find((x) => x.id === foodId);
    if (!f || lines.some((l) => l.mealType === mealType && l.foodId === foodId)) return;
    setLines([...lines, { key: `${mealType}-${foodId}`, mealType, foodId, priceRial: f.defaultPriceRial != null ? String(f.defaultPriceRial) : '', capacity: f.defaultCapacity != null ? String(f.defaultCapacity) : '' }]);
  };
  const upd = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const invalid = !caf ? 'سلف را انتخاب کنید' : !lines.length ? 'حداقل یک غذا اضافه کنید' : lines.some((l) => !/^\d+$/.test(l.priceRial) || !/^\d+$/.test(l.capacity) || Number(l.capacity) < 1) ? 'قیمت و ظرفیت همه‌ی ردیف‌ها را کامل کنید' : '';
  const nDays = Math.min(Math.max(Number(days) || 1, 1), 14);

  const save = async () => {
    if (invalid) return;
    setBusy(true); setErr('');
    try {
      const items = Array.from({ length: nDays }).flatMap((_, i) => {
        const d = addDays(date, i), prev = addDays(d, -1);
        return lines.map((l) => ({ serviceDate: d, mealType: l.mealType as 'Lunch', foodId: l.foodId, cafeteriaId: caf, priceRial: Number(l.priceRial), capacity: Number(l.capacity), reserveDeadline: tehranLocalToIso(`${prev}T${reserveTime}`), cancelDeadline: tehranLocalToIso(`${prev}T${cancelTime}`), notes: '' }));
      });
      const r = await offeringsBulk({ token, mode: 'items', items });
      toast.success(`${faNum(r.created)} وعده ساخته شد${r.skipped ? ` · ${faNum(r.skipped)} مورد تکراری رد شد` : ''}.`);
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl" className="max-h-[94vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><CalendarPlus className="h-5 w-5 text-primary" />چیدن منوی روز</DialogTitle><DialogDescription>غذاها را از کتابخانه برای هر وعده انتخاب کنید؛ قیمت و ظرفیت پیش‌فرض خودکار پر می‌شود و قابل تغییر است.</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2"><Label>تاریخ</Label><Input type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} /><p className="text-xs text-muted-foreground">{faDate(date)}{nDays > 1 && ` تا ${faDate(addDays(date, nDays - 1))}`}</p></div>
          <div className="space-y-1.5"><Label>تکرار برای (روز)</Label><Input inputMode="numeric" dir="ltr" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} /></div>
          <div className="space-y-1.5"><Label>سلف</Label><Select value={caf || undefined} onValueChange={setCaf}><SelectTrigger><SelectValue placeholder="انتخاب سلف" /></SelectTrigger><SelectContent>{cafs.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <div className="space-y-3">
          {MEAL_KEYS.map((m) => {
            const mine = lines.filter((l) => l.mealType === m);
            const options = foods.filter((f) => (f.suitableMeals.length ? f.suitableMeals.includes(m) : true) && !mine.some((l) => l.foodId === f.id));
            return (
              <div key={m} className="rounded-xl border bg-secondary/20 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{MEALS[m]} <span className="text-xs font-normal text-muted-foreground">({faNum(mine.length)} غذا)</span></span>
                  <Select value="" onValueChange={(v) => add(m, v)}><SelectTrigger className="h-8 w-full sm:w-56"><SelectValue placeholder="+ افزودن غذا از کتابخانه" /></SelectTrigger><SelectContent>{options.length ? options.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}{f.category ? ` · ${f.category}` : ''}</SelectItem>) : <div className="p-2 text-xs text-muted-foreground">غذای دیگری برای این وعده نیست</div>}</SelectContent></Select>
                </div>
                {mine.map((l) => (
                  <div key={l.key} className="mt-2 grid grid-cols-[1fr_auto] items-center gap-2 rounded-lg bg-card p-2 sm:grid-cols-[1fr_9rem_6rem_auto]">
                    <span className="truncate text-sm font-medium">{foods.find((f) => f.id === l.foodId)?.name}</span>
                    <Button size="icon" variant="ghost" className="h-8 w-8 sm:order-last" aria-label="حذف" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    <div className="col-span-2 sm:col-span-1"><Input className="h-8" inputMode="numeric" dir="ltr" placeholder="قیمت (ریال)" value={l.priceRial} onChange={(e) => upd(l.key, { priceRial: e.target.value.replace(/\D/g, '') })} />{l.priceRial && <span className="text-[10px] text-muted-foreground">{rial(Number(l.priceRial))}</span>}</div>
                    <Input className="col-span-2 h-8 sm:col-span-1" inputMode="numeric" dir="ltr" placeholder="ظرفیت" value={l.capacity} onChange={(e) => upd(l.key, { capacity: e.target.value.replace(/\D/g, '') })} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>مهلت رزرو (روز قبل، ساعت)</Label><Input type="time" dir="ltr" value={reserveTime} onChange={(e) => setReserveTime(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>مهلت لغو (روز قبل، ساعت)</Label><Input type="time" dir="ltr" value={cancelTime} onChange={(e) => setCancelTime(e.target.value)} /></div>
        </div>
        <ErrorNote message={err} onClose={() => setErr('')} />
        <DialogFooter className="gap-2">
          <span className="me-auto self-center text-xs text-muted-foreground">{lines.length ? `${faNum(lines.length * nDays)} وعده ساخته می‌شود` : invalid}</span>
          <Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button>
          <Button onClick={save} disabled={busy || !!invalid}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ثبت منو</Button>
        </DialogFooter>
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
