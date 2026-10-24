import { useMemo, useState } from 'react';
import { Camera, Loader2, Minus, Plus, Search, Trash2, UtensilsCrossed, X } from 'lucide-react';
import { toast } from 'sonner';
import { catalogList, catalogSave } from '../../lib/api';
import { useUpload } from '../../lib/upload';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Textarea } from '@project/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorNote, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { MEALS, errMsg, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { Catalog, Food } from '../../lib/types';

export const FOOD_CATEGORIES = ['خورشتی', 'پلویی', 'کبابی', 'سوخاری و فست‌فود', 'گیاهی', 'صبحانه', 'سایر'];
const CAT_EMOJI: Record<string, string> = { 'خورشتی': '🍲', 'پلویی': '🍛', 'کبابی': '🍢', 'سوخاری و فست‌فود': '🍔', 'گیاهی': '🥗', 'صبحانه': '🍳', 'سایر': '🍽️' };
const MEAL_EMOJI: Record<string, string> = { Breakfast: '🍳', Lunch: '🍛', Dinner: '🍲' };
const PRICE_CHIPS = [500000, 1000000, 2000000, 3000000];
type Form = Omit<Food, 'id' | 'defaultPriceRial' | 'defaultCapacity'> & { id?: string; defaultPriceRial: string; defaultCapacity: string };
const empty: Form = { name: '', description: '', active: true, isDemo: false, category: '', defaultPriceRial: '', defaultCapacity: '100', suitableMeals: ['Lunch'], imageUrl: '' };
const ALL = '__all__';

function FoodCard({ f, onEdit }: { f: Food; onEdit: () => void }) {
  return (
    <button onClick={onEdit} className={cn('lift group flex flex-col overflow-hidden rounded-2xl border bg-card text-right shadow-[var(--shadow-sm)] active:scale-[0.98]', !f.active && 'opacity-55 grayscale')}>
      <div className="relative aspect-[4/3] w-full bg-gradient-to-br from-accent to-muted">
        {f.imageUrl ? <img src={f.imageUrl} alt={f.name} loading="lazy" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-4xl">{CAT_EMOJI[f.category] ?? '🍽️'}</div>}
        <div className="absolute inset-x-2 top-2 flex justify-between">
          {f.category ? <span className="rounded-full bg-card/90 px-2 py-0.5 text-[10px] font-semibold shadow-sm backdrop-blur">{f.category}</span> : <span />}
          {!f.active ? <Pill tone="muted">غیرفعال</Pill> : f.isDemo ? <Pill tone="warning">نمایشی</Pill> : null}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="truncate font-bold">{f.name}</span>
        <span className="text-[11px]">{f.suitableMeals.map((m) => MEAL_EMOJI[m]).join(' ')} <span className="text-muted-foreground">{f.suitableMeals.map((m) => MEALS[m]).join('، ')}</span></span>
        <span className="num mt-auto pt-1 text-sm font-extrabold text-primary">{f.defaultPriceRial != null ? rial(f.defaultPriceRial) : '—'}</span>
      </div>
    </button>
  );
}

export default function FoodsPage() {
  const { token } = useSession();
  const { data, error, loading, reload } = useLoad(async (t) => (await catalogList({ token: t })) as Catalog);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(ALL);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const foods = useMemo(() => (data?.foods ?? []).filter((f) => (showInactive || f.active) && (cat === ALL || f.category === cat) && (!q || f.name.includes(q) || f.description.includes(q))), [data, q, cat, showInactive]);
  const openNew = () => setForm({ ...empty });

  return (
    <>
      <PageHeader title="کتابخانه‌ی غذا" subtitle="هر غذا را یک‌بار بسازید و در منوها استفاده کنید." actions={<Button className="hidden h-11 rounded-xl sm:inline-flex" onClick={openNew}><Plus className="ms-1 h-4 w-4" />غذای جدید</Button>} />
      <div className="mb-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1"><Search className="absolute right-3 top-3.5 h-4 w-4 text-muted-foreground" /><Input className="h-11 rounded-xl pr-9" placeholder="جست‌وجوی غذا" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <label className="flex h-11 items-center gap-2 whitespace-nowrap rounded-xl border bg-card px-3 text-xs"><Switch checked={showInactive} onCheckedChange={setShowInactive} />غیرفعال‌ها</label>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
          {[ALL, ...FOOD_CATEGORIES].map((c) => (
            <button key={c} onClick={() => setCat(c)} className={cn('h-9 shrink-0 rounded-full border px-3.5 text-xs font-medium transition active:scale-95', cat === c ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground')}>{c === ALL ? 'همه' : `${CAT_EMOJI[c]} ${c}`}</button>
          ))}
        </div>
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !foods.length ? (
        <EmptyState title="غذایی پیدا نشد" text="اولین غذا را به کتابخانه اضافه کنید." action={<Button onClick={openNew}><Plus className="ms-1 h-4 w-4" />غذای جدید</Button>} />
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">{faNum(foods.length)} غذا · برای ویرایش روی هر کارت بزنید</p>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            <button onClick={openNew} className="hidden flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-muted-foreground transition hover:border-primary hover:text-primary sm:flex"><Plus className="h-7 w-7" /><span className="text-sm font-semibold">غذای جدید</span></button>
            {foods.map((f) => <FoodCard key={f.id} f={f} onEdit={() => setForm({ ...f, defaultPriceRial: f.defaultPriceRial == null ? '' : String(f.defaultPriceRial), defaultCapacity: f.defaultCapacity == null ? '' : String(f.defaultCapacity) })} />)}
          </div>
        </>
      )}
      <button onClick={openNew} aria-label="غذای جدید" className="fixed bottom-24 left-5 z-30 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[var(--shadow-xl)] active:scale-95 sm:hidden"><Plus className="h-6 w-6" /></button>
      <FoodEditor form={form} setForm={setForm} token={token} onSaved={reload} />
    </>
  );
}

function FoodEditor({ form, setForm, token, onSaved }: { form: Form | null; setForm: (f: Form | null) => void; token: string; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { upload, isUploading } = useUpload();
  const formErr = form && (form.name.trim().length < 2 ? 'نام غذا را وارد کنید' : !form.suitableMeals.length ? 'حداقل یک وعده انتخاب کنید' : '');
  const close = () => { if (!busy) { setErr(''); setForm(null); } };
  const set = (p: Partial<Form>) => form && setForm({ ...form, ...p });
  const toggleMeal = (m: string) => form && set({ suitableMeals: form.suitableMeals.includes(m) ? form.suitableMeals.filter((x) => x !== m) : [...form.suitableMeals, m] });
  const cap = Number(form?.defaultCapacity || 0);
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const { url } = await upload(file); set({ imageUrl: url }); } catch { toast.error('بارگذاری تصویر انجام نشد.'); }
  };
  const save = async () => {
    if (!form || formErr) return;
    setBusy(true); setErr('');
    try {
      await catalogSave({ token, item: { kind: 'food', id: form.id, name: form.name.trim(), description: form.description, active: form.active, isDemo: form.isDemo, category: form.category, defaultPriceRial: form.defaultPriceRial ? Number(form.defaultPriceRial) : null, defaultCapacity: form.defaultCapacity ? Number(form.defaultCapacity) : null, suitableMeals: form.suitableMeals as ('Lunch')[], imageUrl: form.imageUrl } });
      toast.success(form.id ? 'غذا به‌روزرسانی شد.' : 'غذا به کتابخانه اضافه شد.'); setForm(null); onSaved();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!form} onOpenChange={(o) => !o && close()}>
      <DialogContent dir="rtl" className="flex h-[100dvh] max-h-[100dvh] max-w-full flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-3xl [&>button]:hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <button onClick={close} aria-label="بستن" className="grid h-10 w-10 place-items-center rounded-full hover:bg-muted"><X className="h-5 w-5" /></button>
          <DialogTitle className="text-base font-bold">{form?.id ? 'ویرایش غذا' : 'غذای جدید'}</DialogTitle>
          <span className="w-10" />
        </div>
        <DialogDescription className="sr-only">ویرایش اطلاعات غذا</DialogDescription>
        {form && (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <label className="relative block aspect-[16/9] cursor-pointer overflow-hidden rounded-2xl border-2 border-dashed bg-muted/50">
              {form.imageUrl ? <img src={form.imageUrl} alt="" className="h-full w-full object-cover" /> : (
                <span className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">{isUploading ? <Loader2 className="h-7 w-7 animate-spin" /> : <Camera className="h-7 w-7" />}<span className="text-xs">افزودن عکس غذا (اختیاری)</span></span>
              )}
              <input type="file" accept="image/*" className="hidden" onChange={onFile} disabled={isUploading} />
              {form.imageUrl && <button type="button" onClick={(e) => { e.preventDefault(); set({ imageUrl: '' }); }} className="absolute left-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-card/90 text-destructive shadow"><Trash2 className="h-4 w-4" /></button>}
            </label>
            <div className="space-y-1.5"><Label>نام غذا</Label><Input className="h-12 rounded-xl text-base" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="مثلاً چلوخورش قیمه" /></div>
            <div className="space-y-2"><Label>دسته</Label>
              <div className="flex flex-wrap gap-2">{FOOD_CATEGORIES.map((c) => <button type="button" key={c} onClick={() => set({ category: c })} className={cn('h-9 rounded-full border px-3 text-xs font-medium transition', form.category === c ? 'border-primary bg-primary text-primary-foreground' : 'bg-card')}>{CAT_EMOJI[c]} {c}</button>)}</div></div>
            <div className="space-y-2"><Label>وعده‌های مناسب</Label>
              <div className="grid grid-cols-3 gap-2">{Object.entries(MEALS).map(([k, v]) => <button type="button" key={k} onClick={() => toggleMeal(k)} className={cn('flex h-14 flex-col items-center justify-center rounded-2xl border text-xs font-semibold transition', form.suitableMeals.includes(k) ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/20' : 'bg-card text-muted-foreground')}><span className="text-lg">{MEAL_EMOJI[k]}</span>{v}</button>)}</div></div>
            <div className="space-y-2"><Label>قیمت پیش‌فرض (ریال)</Label>
              <Input className="h-12 rounded-xl text-base" inputMode="numeric" dir="ltr" value={form.defaultPriceRial} onChange={(e) => set({ defaultPriceRial: e.target.value.replace(/\D/g, '') })} />
              {form.defaultPriceRial && <p className="num text-xs font-semibold text-primary">{rial(Number(form.defaultPriceRial))}</p>}
              <div className="flex flex-wrap gap-1.5">{PRICE_CHIPS.map((p) => <button type="button" key={p} onClick={() => set({ defaultPriceRial: String(p) })} className="num rounded-lg bg-muted px-2.5 py-1.5 text-[11px]">{rial(p)}</button>)}</div></div>
            <div className="space-y-2"><Label>ظرفیت پیش‌فرض</Label>
              <div className="flex h-12 items-center justify-between rounded-xl border bg-card px-1">
                <Button type="button" size="icon" variant="ghost" onClick={() => set({ defaultCapacity: String(cap + 10) })}><Plus className="h-4 w-4" /></Button>
                <input className="w-24 bg-transparent text-center text-lg font-bold outline-none" inputMode="numeric" dir="ltr" value={form.defaultCapacity} onChange={(e) => set({ defaultCapacity: e.target.value.replace(/\D/g, '') })} />
                <Button type="button" size="icon" variant="ghost" onClick={() => set({ defaultCapacity: String(Math.max(cap - 10, 0)) })}><Minus className="h-4 w-4" /></Button>
              </div></div>
            <div className="space-y-1.5"><Label>توضیحات (مواد، حساسیت‌زاها)</Label><Textarea className="rounded-xl" rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })} /></div>
            <div className="divide-y rounded-2xl border">
              <label className="flex items-center justify-between p-3.5 text-sm">فعال و قابل استفاده در منو<Switch checked={form.active} onCheckedChange={(v) => set({ active: v })} /></label>
              <label className="flex items-center justify-between p-3.5 text-sm">نمایشی (آزمایشی)<Switch checked={form.isDemo} onCheckedChange={(v) => set({ isDemo: v })} /></label>
            </div>
            <ErrorNote message={err} onClose={() => setErr('')} />
          </div>
        )}
        <div className="border-t bg-card px-5 py-3 pb-safe">
          <Button className="h-12 w-full rounded-2xl text-base font-bold" onClick={save} disabled={busy || isUploading || !!formErr}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}{formErr || 'ذخیره'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
