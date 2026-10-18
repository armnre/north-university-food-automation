import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Users, ArrowUpDown, CalendarPlus, Copy } from 'lucide-react';
import { CopyMenuDialog, DayMenuBuilder } from '../../components/MenuTools';
import { toast } from 'sonner';
import { catalogList, offeringSave, offeringsList, reservationsAdminList } from 'zitejs/api';
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
import { useSession } from '../../lib/session';
import type { AdminReservation, Catalog, Offering } from '../../lib/types';

type Form = { id?: string; serviceDate: string; mealType: string; foodId: string; cafeteriaId: string; priceRial: string; capacity: string; reserveDeadline: string; cancelDeadline: string; active: boolean; notes: string; reason: string; orig?: Offering };
const ALL = '__all__';
type SortKey = 'serviceDate' | 'foodName' | 'priceRial' | 'remaining';

function defaultsFor(date: string, meal: string) {
  const hour = meal === 'Breakfast' ? '07:00' : meal === 'Lunch' ? '12:00' : '19:00';
  const prev = addDays(date, -1);
  return { reserveDeadline: `${prev}T20:00`, cancelDeadline: `${prev}T22:00`, _hour: hour };
}

export default function OfferingsPage() {
  const { token } = useSession();
  const [weekStart, setWeekStart] = useState(tehranToday());
  const [caf, setCaf] = useState(ALL);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'serviceDate', dir: 1 });
  const to = addDays(weekStart, 6);
  const { data, error, loading, reload } = useLoad(async (t) => {
    const [o, c] = await Promise.all([offeringsList({ token: t, from: weekStart, to, cafeteriaId: caf === ALL ? undefined : caf }), catalogList({ token: t })]);
    return { offerings: (o as { offerings: Offering[] }).offerings, catalog: c as Catalog };
  }, [weekStart, caf]);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<Offering | null>(null);
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
    const d = defaultsFor(weekStart, 'Lunch');
    setForm({ serviceDate: weekStart, mealType: 'Lunch', foodId: '', cafeteriaId: caf === ALL ? '' : caf, priceRial: '', capacity: '', reserveDeadline: d.reserveDeadline, cancelDeadline: d.cancelDeadline, active: true, notes: '', reason: '' });
  };
  const openEdit = (o: Offering) => setForm({ id: o.id, serviceDate: o.serviceDate, mealType: o.mealType, foodId: o.foodId, cafeteriaId: o.cafeteriaId, priceRial: String(o.priceRial), capacity: String(o.capacity), reserveDeadline: isoToLocalInput(o.reserveDeadline), cancelDeadline: isoToLocalInput(o.cancelDeadline), active: o.active, notes: o.notes, reason: '', orig: o });

  const formErr = form && (!form.foodId ? 'غذا را انتخاب کنید' : !form.cafeteriaId ? 'سلف را انتخاب کنید' : !/^\d+$/.test(form.priceRial) ? 'قیمت باید عدد صحیح (ریال) باشد'
    : !/^\d+$/.test(form.capacity) || Number(form.capacity) < 1 ? 'ظرفیت باید حداقل ۱ باشد' : form.orig && Number(form.capacity) < form.orig.reserved ? `ظرفیت کمتر از رزروهای فعلی (${faNum(form.orig.reserved)}) مجاز نیست`
    : !form.reserveDeadline || !form.cancelDeadline ? 'مهلت‌ها را تعیین کنید' : '');

  const save = async () => {
    if (!form || formErr) return;
    setBusy(true); setSaveErr('');
    try {
      await offeringSave({ token, id: form.id, serviceDate: form.serviceDate, mealType: form.mealType as 'Lunch', foodId: form.foodId, cafeteriaId: form.cafeteriaId, priceRial: Number(form.priceRial), capacity: Number(form.capacity), reserveDeadline: tehranLocalToIso(form.reserveDeadline), cancelDeadline: tehranLocalToIso(form.cancelDeadline), active: form.active, notes: form.notes, reason: form.reason || undefined });
      toast.success('وعده ذخیره شد.'); setForm(null); reload();
    } catch (e) { setSaveErr(errMsg(e)); } finally { setBusy(false); }
  };
  const sortBtn = (k: SortKey, label: string) => <button className="inline-flex items-center gap-1" onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : 1 })}>{label}<ArrowUpDown className="h-3 w-3" /></button>;

  return (
    <>
      <PageHeader title="منو، وعده و ظرفیت" subtitle="تغییر قیمت روی رزروهای قبلی اثر ندارد؛ هر رزرو قیمت لحظه‌ی ثبت را نگه می‌دارد." actions={<div className="flex flex-wrap gap-2">
        <Button onClick={() => setBuilder(true)} disabled={!data?.catalog.foods.length || !data?.catalog.cafeterias.length}><CalendarPlus className="ms-1 h-4 w-4" />چیدن منوی روز</Button>
        <Button variant="outline" onClick={() => setCopyOpen(true)}><Copy className="ms-1 h-4 w-4" />کپی منو</Button>
        <Button variant="outline" onClick={() => { setSaveErr(''); openNew(); }} disabled={!data?.catalog.foods.length || !data?.catalog.cafeterias.length}><Plus className="ms-1 h-4 w-4" />تک وعده</Button>
      </div>} />
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
          <Button size="icon" variant="ghost" aria-label="هفته قبل" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronRight className="h-4 w-4" /></Button>
          <span className="min-w-[180px] text-center text-sm font-medium">{faShort(weekStart)} تا {faShort(to)}</span>
          <Button size="icon" variant="ghost" aria-label="هفته بعد" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setWeekStart(tehranToday())}>امروز</Button>
        </div>
        <Select value={caf} onValueChange={setCaf}><SelectTrigger className="lg:w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>همه‌ی سلف‌ها</SelectItem>{data?.catalog.cafeterias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select>
        <Input className="lg:max-w-xs" placeholder="جست‌وجوی غذا یا سلف" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {data && (!data.catalog.foods.length || !data.catalog.cafeterias.length) && <p className="mb-4 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">ابتدا حداقل یک غذا در «کتابخانه‌ی غذا» و یک سلف تعریف کنید.</p>}
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? <EmptyState title="در این بازه وعده‌ای تعریف نشده است" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
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
                    <TableCell className="whitespace-nowrap text-sm">{faDate(o.serviceDate)}</TableCell><TableCell>{MEALS[o.mealType]}</TableCell><TableCell className="font-medium">{o.foodName}</TableCell>
                    <TableCell className="hidden md:table-cell">{o.cafeteriaName}</TableCell><TableCell className="num whitespace-nowrap">{rial(o.priceRial)}</TableCell>
                    <TableCell className="num">{faNum(o.reserved)} / {faNum(o.capacity)}</TableCell><TableCell className="num hidden sm:table-cell">{faNum(o.delivered)}</TableCell>
                    <TableCell>{!o.active ? <Pill tone="muted">غیرفعال</Pill> : o.remaining === 0 ? <Pill tone="danger">تکمیل</Pill> : closed ? <Pill tone="warning">بسته</Pill> : <Pill tone="success">باز</Pill>}</TableCell>
                    <TableCell className="whitespace-nowrap"><Button size="icon" variant="ghost" aria-label="رزروها" onClick={() => setView(o)}><Users className="h-4 w-4" /></Button><Button size="icon" variant="ghost" aria-label="ویرایش" onClick={() => openEdit(o)}><Pencil className="h-4 w-4" /></Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!form} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent dir="rtl" className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>{form?.id ? 'ویرایش وعده' : 'وعده‌ی جدید'}</DialogTitle>{form?.orig && form.orig.reserved > 0 && <DialogDescription>این وعده {faNum(form.orig.reserved)} رزرو دارد؛ تاریخ، وعده و سلف قفل است و تغییر قیمت فقط برای رزروهای بعدی اعمال می‌شود.</DialogDescription>}</DialogHeader>
          {form && data && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>تاریخ ارائه</Label><Input type="date" dir="ltr" value={form.serviceDate} disabled={!!form.orig?.reserved} onChange={(e) => setForm({ ...form, serviceDate: e.target.value })} /><p className="text-xs text-muted-foreground">{faDate(form.serviceDate)}</p></div>
              <div className="space-y-1.5"><Label>وعده</Label><Select value={form.mealType} disabled={!!form.orig?.reserved} onValueChange={(v) => setForm({ ...form, mealType: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(MEALS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>غذا</Label><Select value={form.foodId || undefined} onValueChange={(v) => { const fd = data.catalog.foods.find((x) => x.id === v); setForm({ ...form, foodId: v, priceRial: form.priceRial || (fd?.defaultPriceRial != null ? String(fd.defaultPriceRial) : ''), capacity: form.capacity || (fd?.defaultCapacity != null ? String(fd.defaultCapacity) : '') }); }}><SelectTrigger><SelectValue placeholder="انتخاب غذا" /></SelectTrigger><SelectContent>{data.catalog.foods.filter((f) => f.active || f.id === form.foodId).map((f) => <SelectItem key={f.id} value={f.id}>{f.name}{f.isDemo ? ' (نمایشی)' : ''}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>سلف</Label><Select value={form.cafeteriaId || undefined} disabled={!!form.orig?.reserved} onValueChange={(v) => setForm({ ...form, cafeteriaId: v })}><SelectTrigger><SelectValue placeholder="انتخاب سلف" /></SelectTrigger><SelectContent>{data.catalog.cafeterias.filter((c) => c.active || c.id === form.cafeteriaId).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>قیمت (ریال)</Label><Input inputMode="numeric" dir="ltr" value={form.priceRial} onChange={(e) => setForm({ ...form, priceRial: e.target.value.replace(/\D/g, '') })} />{form.priceRial && <p className="text-xs text-muted-foreground">{rial(Number(form.priceRial))}</p>}</div>
              <div className="space-y-1.5"><Label>ظرفیت</Label><Input inputMode="numeric" dir="ltr" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value.replace(/\D/g, '') })} /></div>
              <div className="space-y-1.5"><Label>مهلت رزرو (به وقت تهران)</Label><Input type="datetime-local" dir="ltr" value={form.reserveDeadline} onChange={(e) => setForm({ ...form, reserveDeadline: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>مهلت لغو (به وقت تهران)</Label><Input type="datetime-local" dir="ltr" value={form.cancelDeadline} onChange={(e) => setForm({ ...form, cancelDeadline: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label>توضیحات برای دانشجو</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              <label className="flex items-center justify-between text-sm sm:col-span-2">فعال و قابل رزرو<Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /></label>
              <div className="sm:col-span-2"><ErrorNote message={saveErr || formErr || ''} onClose={saveErr ? () => setSaveErr('') : undefined} /></div>
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setForm(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={busy || !!formErr}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <OfferingReservations offering={view} onClose={() => setView(null)} />
      {data && <DayMenuBuilder open={builder} onClose={() => setBuilder(false)} onDone={reload} token={token} catalog={data.catalog} initialDate={addDays(tehranToday(), 1)} />}
      <CopyMenuDialog open={copyOpen} onClose={() => setCopyOpen(false)} onDone={reload} token={token} weekStart={weekStart} />
    </>
  );
}

function OfferingReservations({ offering, onClose }: { offering: Offering | null; onClose: () => void }) {
  const { data, loading, error } = useLoad(async (t) => (offering ? ((await reservationsAdminList({ token: t, offeringId: offering.id, offset: 0 })) as { reservations: AdminReservation[] }).reservations : []), [offering?.id]);
  return (
    <Dialog open={!!offering} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>رزروهای {offering?.foodName}</DialogTitle><DialogDescription>{offering && `${MEALS[offering.mealType]} · ${faDate(offering.serviceDate)} · ${offering.cafeteriaName}`}</DialogDescription></DialogHeader>
        {loading ? <LoadingBlock rows={3} /> : error ? <p className="text-sm text-destructive">{error}</p> : !data?.length ? <p className="py-6 text-center text-sm text-muted-foreground">رزروی ثبت نشده است.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">شماره دانشجویی</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="text-right">مبلغ</TableHead><TableHead className="text-right">وضعیت</TableHead></TableRow></TableHeader>
            <TableBody>{data.map((r) => <TableRow key={r.id}><TableCell className="num">{faDigits(r.studentNumber)}</TableCell><TableCell>{r.studentName}</TableCell><TableCell className="num">{rial(r.priceAtBooking)}</TableCell><TableCell><Pill tone={RES_STATUS[r.status]?.tone ?? 'muted'}>{RES_STATUS[r.status]?.label ?? r.status}</Pill></TableCell></TableRow>)}</TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}
