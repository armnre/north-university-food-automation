import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@project/components/ui/popover';
import { Button } from '@project/components/ui/button';
import { cn } from '@project/components/lib/utils';

/** Gregorian ⇄ Jalali (jalaali-js algorithm). Value in/out stays ISO "YYYY-MM-DD" so the API is unchanged. */
const div = (a: number, b: number) => Math.trunc(a / b);
function g2d(gy: number, gm: number, gd: number) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * ((gm + 9) % 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}
function d2g(jdn: number) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(j % 1461, 4) * 5 + 308;
  const gd = div(i % 153, 5) + 1, gm = (div(i, 153) % 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return [gy, gm, gd] as const;
}
function jalCal(jy: number) {
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const gy = jy + 621;
  let leapJ = -14, jp = breaks[0]!, jump = 0;
  for (let i = 1; i < breaks.length; i++) {
    const jm = breaks[i]!; jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(jump % 33, 4); jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div((n % 33) + 3, 4);
  if (jump % 33 === 4 && jump - n === 4) leapJ++;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = (((n + 1) % 33) - 1) % 4; if (leap === -1) leap = 4;
  return { gy, march, leap };
}
const j2d = (jy: number, jm: number, jd: number) => { const r = jalCal(jy); return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1; };
function d2j(jdn: number) {
  const gy = d2g(jdn)[0]; let jy = gy - 621; const r = jalCal(jy);
  let k = jdn - g2d(gy, 3, r.march);
  if (k >= 0) { if (k <= 185) return [jy, 1 + div(k, 31), (k % 31) + 1] as const; k -= 186; }
  else { jy--; k += 179; if (r.leap === 1) k++; }
  return [jy, 7 + div(k, 30), (k % 30) + 1] as const;
}
const monthLen = (jy: number, jm: number) => (jm <= 6 ? 31 : jm <= 11 ? 30 : jalCal(jy).leap === 0 ? 30 : 29);
const toIso = (jdn: number) => { const [y, m, d] = d2g(jdn); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
const fromIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return g2d(y!, m!, d!); };

const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const WEEK = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
const fa = (n: number) => n.toLocaleString('fa-IR', { useGrouping: false });
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });

type Props = { value: string; onChange: (iso: string) => void; disabled?: boolean; className?: string; 'aria-label'?: string };

export default function JalaliDateInput({ value, onChange, disabled, className, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const sel = value ? d2j(fromIso(value)) : null;
  const [view, setView] = useState<[number, number]>(() => { const j = d2j(fromIso(value || todayIso())); return [j[0], j[1]]; });
  const [vy, vm] = view;
  const cells = useMemo(() => {
    const first = j2d(vy, vm, 1);
    const offset = (first + 2) % 7; // JDN%7: 0=Mon → Saturday-first grid
    return { offset, days: monthLen(vy, vm), first };
  }, [vy, vm]);
  const shift = (d: number) => { let m = vm + d, y = vy; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } setView([y, m]); };
  const today = todayIso();
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o && sel) setView([sel[0], sel[1]]); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled} aria-label={rest['aria-label']} className={cn('h-10 w-full justify-between font-normal', !sel && 'text-muted-foreground', className)}>
          {sel ? `${fa(sel[2])} ${MONTHS[sel[1] - 1]} ${fa(sel[0])}` : 'انتخاب تاریخ'}
          <CalendarDays className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start" dir="rtl">
        <div className="mb-2 flex items-center justify-between">
          <Button type="button" size="icon" variant="ghost" aria-label="ماه قبل" onClick={() => shift(-1)}><ChevronRight className="h-4 w-4" /></Button>
          <span className="text-sm font-semibold">{MONTHS[vm - 1]} {fa(vy)}</span>
          <Button type="button" size="icon" variant="ghost" aria-label="ماه بعد" onClick={() => shift(1)}><ChevronLeft className="h-4 w-4" /></Button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs">
          {WEEK.map((w) => <span key={w} className="py-1 text-muted-foreground">{w}</span>)}
          {Array.from({ length: cells.offset }).map((_, i) => <span key={`e${i}`} />)}
          {Array.from({ length: cells.days }).map((_, i) => {
            const iso = toIso(cells.first + i);
            const active = iso === value;
            return (
              <button key={iso} type="button" onClick={() => { onChange(iso); setOpen(false); }}
                className={cn('h-8 rounded-md text-sm transition-colors hover:bg-muted', active && 'bg-primary text-primary-foreground hover:bg-primary', !active && iso === today && 'ring-1 ring-primary')}>
                {fa(i + 1)}
              </button>
            );
          })}
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" onClick={() => { onChange(today); setOpen(false); }}>امروز</Button>
      </PopoverContent>
    </Popover>
  );
}
