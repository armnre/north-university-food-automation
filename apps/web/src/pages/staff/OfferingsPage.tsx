import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Users, ArrowUpDown, CalendarPlus, Copy, Ban } from 'lucide-react';
import { CopyMenuDialog, DayMenuBuilder } from '../../components/MenuTools';
import { toast } from 'sonner';
import { catalogList, offeringSave, offeringStatus, offeringsList, reservationsAdminList } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Textarea } from '@project/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorNote, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { MEALS, RES_STATUS, addDays, errMsg, faDate, faDigits, faNum, faShort, isoToLocalInput, rial, tehranLocalToIso, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { AdminReservation, Catalog, Offering } from '../../lib/types';

type Form = { id?: string; serviceDate: string; mealSlot: string; foodId: string; priceRial: string; capacity: string; reserveDeadline: string; active: boolean; notes: string; reason: string; orig?: Offering };
type SortKey = 'serviceDate' | 'foodName' | 'priceRial' | 'remaining';

function defaultsFor(date: string) {
  const prev = addDays(date, -1);
  return { reserveDeadline: `${prev}T20:00` };
}

export default function OfferingsPage() {
  const [weekStart, setWeekStart] = useState(tehranToday());
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'serviceDate', dir: 1 });
  const to = addDays(weekStart, 6);
  const { data, error, loading, reload } = useLoad(async () => {
    const [o, c] = await Promise.all([offeringsList({ from: weekStart, to }), catalogList()]);
    return { offerings: (o as { offerings: Offering[] }).offerings, catalog: c as Catalog };
  }, [weekStart]);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<Offering | null>(null);
  const [closeTarget, setCloseTarget] = useState<{ offering: Offering; status: 'SoldOut' | 'Cancelled' } | null>(null);
  const [builder, setBuilder] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  const rows = useMemo(() => {
    const xs = (data?.offerings ?? []).filter((o) => !q || o.foodName.includes(q) || o.cafeteriaName.includes(q));
    return [...xs].sort((a, b) => {
      const av = a[sort.k], bv = b[sort.k];
      return (typeof av === 'number' ? (av as number) - (bv as number) : String(av).localeCompare(String(bv), 'fa')) * sort.dir;
    });
  }, [data, q, sort]);

  const openNew = () => {
    const d = defaultsFor(weekStart);
    setForm({ serviceDate: weekStart, mealSlot: 'Lunch', foodId: '', priceRial: '', capacity: '', reserveDeadline: d.reserveDeadline, active: true, notes: '', reason: '' });
  };
  const openEdit = (o: Offering) => setForm({ id: o.id, serviceDate: o.serviceDate, mealSlot: o.mealSlot, foodId: o.foodId, priceRial: String(o.priceRial), capacity: String(o.capacity), reserveDeadline: isoToLocalInput(o.reserveDeadline), active: o.active, notes: o.notes, reason: '', orig: o });

  const formErr = form && (!form.foodId ? 'غذا را انتخاب کنید' : !/^\d+$/.test(form.priceRial) ? 'قیمت باید عدد صحیح (ریال) باشد'
    : !/^\d+$/.test(form.capacity) || Number(form.capacity) < 1 ? 'ظرفیت باید حداقل ۱ باشد' : form.orig && Number(form.capacity) < form.orig.reserved ? `ظرفیت کمتر از رزروهای فعلی (${faNum(form.orig.reserved)}) مجاز نیست`
    : !form.reserveDeadline ? 'مهلت رزرو را تعیین کنید' : '');

  const save = async () => {
    if (!form || formErr) return;
    setBusy(true); setSaveErr('');
    try {
      await offeringSave({ id: form.id, serviceDate: form.serviceDate, mealSlot: form.mealSlot as 'Lunch', foodId: form.foodId, priceRial: Number(form.priceRial), capacity: Number(form.capacity), reserveDeadline: tehranLocalToIso(form.reserveDeadline), active: form.active, notes: form.notes, reason: form.reason || undefined });
      toast.success('وعده ذخیره شد.'); setForm(null); reload();
    } catch (e) { setSaveErr(errMsg(e)); } finally { setBusy(false); }
  };
  const sortBtn = (k: SortKey, label: string) => <button className="inline-flex items-center gap-1" onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : 1 })}>{label}<ArrowUpDown className="h-3 w-3" /></button>;

  return (
    <>
      <PageHeader title="منو، وعده و ظرفیت" subtitle="تغییر قیمت روی رزروهای قبلی اثر ندارد." actions={<div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
        <Button className="h-11 rounded-xl" onClick={() => setBuilder(true)} disabled={!data?.catalog.foods.length}><CalendarPlus className="ms-1 h-4 w-4" />منوی روز</Button>
        <Button variant="outline" className="h-11 rounded-xl" onClick={() => setCopyOpen(true)}><Copy className="ms-1 h-4 w-4" />کپی منو</Button>
        <Button variant="outline" className="h-11 rounded-xl" onClick={() => { setSaveErr(''); openNew(); }} disabled={!data?.catalog.foods.length}><Plus className="ms-1 h-4 w-4" />تک وعده</Button>
      </div>} />
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex items-center justify-between gap-1 rounded-2xl border bg-card p-1 shadow-[var(--shadow-sm)]">
          <Button size="icon" variant="ghost" aria-label="هفته قبل" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronRight className="h-4 w-4" /></Button>
          <span className="flex-1 text-center text-sm font-semibold lg:min-w-[180px]">{faShort(weekStart)} تا {faShort(to)}</span>
          <Button size="icon" variant="ghost" aria-label="هفته بعد" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setWeekStart(tehranToday())}>امروز</Button>
        </div>
        <div className="flex gap-2">
        <Input className="h-11 rounded-xl lg:max-w-xs" placeholder="جست‌وجو" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {data && !data.catalog.foods.length && <p className="mb-4 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">ابتدا حداقل یک غذا در «کتابخانه‌ی غذا» تعریف کنید.</p>}
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? <EmptyState title="در این بازه وعده‌ای تعریف نشده است" action={data?.catalog.foods.length ? <Button onClick={() => setBuilder(true)}><CalendarPlus className="ms-1 h-4 w-4" />چیدن منوی روز</Button> : undefined} /> : (
        <>
        <div className="stagger grid gap-3 md:hidden">
          {rows.map((o) => {
            const closed = !o.reserveDeadline || new Date(o.reserveDeadline) < new Date();
            const pct = o.capacity ? Math.round((o.reserved / o.capacity) * 100) : 0;
            return (
              <div key={o.id} className="rounded-2xl border bg-card p-3.5 shadow-[var(--shadow-sm)]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-primary">{MEALS[o.mealSlot]} · {faDate(o.serviceDate)}</div>
                    <div className="truncate font-bold">{o.foodName}</div>
                    <div className="text-xs text-muted-foreground">{o.cafeteriaName}</div>
                  </div>
                  {!o.active ? <Pill tone="muted">غیرفعال</Pill> : o.remaining === 0 ? <Pill tone="danger">تکمیل</Pill> : closed ? <Pill tone="warning">بسته</Pill> : <Pill tone="success">باز</Pill>}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs"><span className="num font-bold">{faNum(o.reserved)}/{faNum(o.capacity)}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
                  <span className="text-muted-foreground">تحویل {faNum(o.delivered)}</span></div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="num font-extrabold">{rial(o.priceRial)}</span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-9 rounded-xl" onClick={() => setView(o)}><Users className="ms-1 h-4 w-4" />رزروها</Button>
                    <Button size="sm" className="h-9 rounded-xl" onClick={() => openEdit(o)}><Pencil className="ms-1 h-4 w-4" />ویرایش</Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="hidden overflow-x-auto rounded-2xl border bg-card shadow-[var(--shadow-sm)] md:block">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="text-right">{sortBtn('serviceDate', 'تاریخ')}</TableHead><TableHead className="text-right">وعده</TableHead><TableHead className="text-right">{sortBtn('foodName', 'غذا')}</TableHead>
              <TableHead className="hidden text-right md:table-cell">سلف</TableHead><TableHead className="text-right">{sortBtn('priceRial', 'قیمت')}</TableHead><TableHead className="text-right">{sortBtn('remaining', 'رزرو / ظرفیت')}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">تحویل</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((o) => {
                const closed = !o.reserveDeadline || new Date(o.reserveDeadline) < new Date();
                return (
                  <TableRow key={o.id}>
                    <TableCell className="whitespace-nowrap text-sm">{faDate(o.serviceDate)}</TableCell><TableCell>{MEALS[o.mealSlot]}</TableCell><TableCell className="font-medium">{o.foodName}</TableCell>
                    <TableCell className="hidden md:table-cell">{o.cafeteriaName}</TableCell><TableCell className="num whitespace-nowrap">{rial(o.priceRial)}</TableCell>
                    <TableCell className="num">{faNum(o.reserved)} / {faNum(o.capacity)}</TableCell><TableCell className="num hidden sm:table-cell">{faNum(o.delivered)}</TableCell>
                    <TableCell>{!o.active ? <Pill tone="muted">غیرفعال</Pill> : o.remaining === 0 ? <Pill tone="danger">تکمیل</Pill> : closed ? <Pill tone="warning">بسته</Pill> : <Pill tone="success">باز</Pill>}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Button size="icon" variant="ghost" aria-label="رزروها" onClick={() => setView(o)}><Users className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" aria-label="ویرایش" onClick={() => openEdit(o)}><Pencil className="h-4 w-4" /></Button>
                      {o.status !== 'Cancelled' && <Button size="icon" variant="ghost" aria-label="لغو وعده یا تمام شد" onClick={() => setCloseTarget({ offering: o, status: 'Cancelled' })}><Ban className="h-4 w-4 text-destructive" /></Button>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        </>
      )}

      <Dialog open={!!form} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent dir="rtl" className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>{form?.id ? 'ویرایش وعده' : 'وعده‌ی جدید'}</DialogTitle>{form?.orig && form.orig.reserved > 0 && <DialogDescription>این وعده {faNum(form.orig.reserved)} رزرو دارد؛ تاریخ، وعده و سلف قفل است و تغییر قیمت فقط برای رزروهای بعدی اعمال می‌شود.</DialogDescription>}</DialogHeader>
          {form && data && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>تاریخ ارائه</Label><Input type="date" dir="ltr" value={form.serviceDate} disabled={!!form.orig?.reserved} onChange={(e) => setForm({ ...form, serviceDate: e.target.value })} /><p className="text-xs text-muted-foreground">{faDate(form.serviceDate)}</p></div>
              <div className="space-y-1.5"><Label>وعده</Label><Select value={form.mealSlot} disabled={!!form.orig?.reserved} onValueChange={(v) => setForm({ ...form, mealSlot: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(MEALS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>غذا</Label><Select value={form.foodId || undefined} onValueChange={(v) => { const fd = data.catalog.foods.find((x) => x.id === v); setForm({ ...form, foodId: v, priceRial: form.priceRial || (fd?.defaultPriceRial != null ? String(fd.defaultPriceRial) : ''), capacity: form.capacity || (fd?.defaultCapacity != null ? String(fd.defaultCapacity) : '') }); }}><SelectTrigger><SelectValue placeholder="انتخاب غذا" /></SelectTrigger><SelectContent>{data.catalog.foods.filter((f) => f.isActive || f.id === form.foodId).map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>قیمت (ریال)</Label><Input inputMode="numeric" dir="ltr" value={form.priceRial} onChange={(e) => setForm({ ...form, priceRial: e.target.value.replace(/\D/g, '') })} />{form.priceRial && <p className="text-xs text-muted-foreground">{rial(Number(form.priceRial))}</p>}</div>
              <div className="space-y-1.5"><Label>ظرفیت</Label><Input inputMode="numeric" dir="ltr" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value.replace(/\D/g, '') })} /></div>
              <div className="space-y-1.5"><Label>مهلت رزرو</Label><Input type="datetime-local" dir="ltr" value={form.reserveDeadline} onChange={(e) => setForm({ ...form, reserveDeadline: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label>توضیحات برای دانشجو</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              <label className="flex items-center justify-between text-sm sm:col-span-2">فعال و قابل رزرو<Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /></label>
              <div className="sm:col-span-2"><ErrorNote message={saveErr || formErr || ''} onClose={saveErr ? () => setSaveErr('') : undefined} /></div>
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setForm(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={busy || !!formErr}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <OfferingReservations offering={view} onClose={() => setView(null)} />
      <CloseOfferingDialog target={closeTarget} onClose={() => setCloseTarget(null)} onDone={reload} />
      {data && <DayMenuBuilder open={builder} onClose={() => setBuilder(false)} onDone={reload} catalog={data.catalog} initialDate={addDays(tehranToday(), 1)} />}
      <CopyMenuDialog open={copyOpen} onClose={() => setCopyOpen(false)} onDone={reload} weekStart={weekStart} />
    </>
  );
}

function CloseOfferingDialog({ target, onClose, onDone }: { target: { offering: Offering; status: 'SoldOut' | 'Cancelled' } | null; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<'Cancelled' | 'SoldOut'>('Cancelled');
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const offering = target?.offering ?? null;
  const expected = status === 'Cancelled' ? 'لغو وعده' : 'تمام شد';
  const needsTyped = (offering?.reserved ?? 0) > 0;
  const valid = reason.trim().length >= 5 && (!needsTyped || confirmText.trim() === expected);

  const submit = async () => {
    if (!offering || !valid) return;
    setBusy(true); setErr('');
    try {
      const r = await offeringStatus(offering.id, { status, reason: reason.trim(), confirmText: needsTyped ? confirmText.trim() : undefined });
      toast.success(`وضعیت وعده تغییر کرد؛ ${faNum(r.cancelledReservations)} رزرو لغو و بازپرداخت شد.`);
      setReason(''); setConfirmText(''); onClose(); onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!offering} onOpenChange={(o) => !o && !busy && (setReason(''), setConfirmText(''), setErr(''), onClose())}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>تغییر وضعیت وعده و بازپرداخت خودکار</DialogTitle>
          <DialogDescription>{offering && `${offering.foodName} · ${MEALS[offering.mealSlot]} · ${faDate(offering.serviceDate)}`}</DialogDescription>
        </DialogHeader>
        {offering && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>وضعیت جدید</Label>
              <Select value={status} onValueChange={(v) => { setStatus(v as 'Cancelled' | 'SoldOut'); setConfirmText(''); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cancelled">لغو وعده (بازپرداخت رزروهای فعال)</SelectItem>
                  <SelectItem value="SoldOut">تمام شد (بازپرداخت رزروهای تحویل‌نشده)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>دلیل الزامی (حداقل ۵ کاراکتر)</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً خرابی تجهیزات آشپزخانه" />
            </div>
            {needsTyped && (
              <div className="space-y-1.5">
                <Label>این وعده {faNum(offering.reserved)} رزرو دارد؛ برای تأیید عبارت «{expected}» را تایپ کنید</Label>
                <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={expected} />
              </div>
            )}
            <ErrorNote message={err} onClose={() => setErr('')} />
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button>
          <Button variant="destructive" onClick={submit} disabled={!valid || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ثبت و بازپرداخت</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OfferingReservations({ offering, onClose }: { offering: Offering | null; onClose: () => void }) {
  const { data, loading, error } = useLoad(async () => (offering ? ((await reservationsAdminList({ offeringId: offering.id, offset: 0 })) as { reservations: AdminReservation[] }).reservations : []), [offering?.id]);
  return (
    <Dialog open={!!offering} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>رزروهای {offering?.foodName}</DialogTitle><DialogDescription>{offering && `${MEALS[offering.mealSlot]} · ${faDate(offering.serviceDate)} · ${offering.cafeteriaName}`}</DialogDescription></DialogHeader>
        {loading ? <LoadingBlock rows={3} /> : error ? <p className="text-sm text-destructive">{error}</p> : !data?.length ? <p className="py-6 text-center text-sm text-muted-foreground">رزروی ثبت نشده است.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">شماره دانشجویی</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="text-right">مبلغ</TableHead><TableHead className="text-right">وضعیت</TableHead></TableRow></TableHeader>
            <TableBody>{data.map((r) => <TableRow key={r.id}><TableCell className="num">{faDigits(r.holderIdentifier)}</TableCell><TableCell>{r.holderName}</TableCell><TableCell className="num">{rial(r.priceRial)}</TableCell><TableCell><Pill tone={RES_STATUS[r.status]?.tone ?? 'muted'}>{RES_STATUS[r.status]?.label ?? r.status}</Pill></TableCell></TableRow>)}</TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}
