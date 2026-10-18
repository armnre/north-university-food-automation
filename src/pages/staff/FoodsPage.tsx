import { useMemo, useState } from 'react';
import { ImageOff, Loader2, Pencil, Plus, Search, UtensilsCrossed } from 'lucide-react';
import { toast } from 'sonner';
import { catalogList, catalogSave } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Textarea } from '@project/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorNote, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { MEALS, errMsg, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { Catalog, Food } from '../../lib/types';

export const FOOD_CATEGORIES = ['خورشتی', 'پلویی', 'کبابی', 'سوخاری و فست‌فود', 'گیاهی', 'صبحانه', 'سایر'];
type Form = Omit<Food, 'id' | 'defaultPriceRial' | 'defaultCapacity'> & { id?: string; defaultPriceRial: string; defaultCapacity: string };
const empty: Form = { name: '', description: '', active: true, isDemo: false, category: '', defaultPriceRial: '', defaultCapacity: '', suitableMeals: ['Lunch'], imageUrl: '' };
const ALL = '__all__';

function FoodCard({ f, onEdit }: { f: Food; onEdit: () => void }) {
  return (
    <button onClick={onEdit} className={cn('group flex flex-col overflow-hidden rounded-2xl border bg-card text-right shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md', !f.active && 'opacity-60')}>
      <div className="relative aspect-[16/9] w-full bg-gradient-to-br from-secondary to-muted">
        {f.imageUrl ? <img src={f.imageUrl} alt={f.name} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-muted-foreground"><UtensilsCrossed className="h-8 w-8 opacity-40" /></div>}
        <span className="absolute left-2 top-2 rounded-full bg-card/90 p-1.5 opacity-0 shadow transition group-hover:opacity-100"><Pencil className="h-3.5 w-3.5" /></span>
        {f.category && <span className="absolute bottom-2 right-2 rounded-full bg-card/90 px-2 py-0.5 text-[11px] font-medium shadow-sm backdrop-blur">{f.category}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-center justify-between gap-2"><span className="truncate font-semibold">{f.name}</span>{!f.active ? <Pill tone="muted">غیرفعال</Pill> : f.isDemo ? <Pill tone="warning">نمایشی</Pill> : null}</div>
        {f.description && <p className="line-clamp-2 text-xs text-muted-foreground">{f.description}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-[11px]">
          {f.suitableMeals.map((m) => <span key={m} className="rounded-md bg-secondary px-1.5 py-0.5">{MEALS[m] ?? m}</span>)}
          {f.defaultPriceRial != null && <span className="num ms-auto font-medium text-primary">{rial(f.defaultPriceRial)}</span>}
        </div>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const foods = useMemo(() => (data?.foods ?? []).filter((f) => (showInactive || f.active) && (cat === ALL || f.category === cat) && (!q || f.name.includes(q) || f.description.includes(q))), [data, q, cat, showInactive]);
  const formErr = form && (form.name.trim().length < 2 ? 'نام غذا حداقل ۲ حرف باشد' : !form.suitableMeals.length ? 'حداقل یک وعده‌ی مناسب انتخاب کنید' : form.imageUrl && !/^https:\/\//.test(form.imageUrl) ? 'آدرس تصویر باید با https شروع شود' : '');

  const save = async () => {
    if (!form || formErr) return;
    setBusy(true); setErr('');
    try {
      await catalogSave({ token, item: { kind: 'food', id: form.id, name: form.name.trim(), description: form.description, active: form.active, isDemo: form.isDemo, category: form.category, defaultPriceRial: form.defaultPriceRial ? Number(form.defaultPriceRial) : null, defaultCapacity: form.defaultCapacity ? Number(form.defaultCapacity) : null, suitableMeals: form.suitableMeals as ('Lunch')[], imageUrl: form.imageUrl } });
      toast.success(form.id ? 'غذا به‌روزرسانی شد.' : 'غذا به کتابخانه اضافه شد.'); setForm(null); reload();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const toggleMeal = (m: string) => form && setForm({ ...form, suitableMeals: form.suitableMeals.includes(m) ? form.suitableMeals.filter((x) => x !== m) : [...form.suitableMeals, m] });

  return (
    <>
      <PageHeader title="کتابخانه‌ی غذا" subtitle="غذاهای ثابت را یک‌بار تعریف کنید؛ هنگام چیدن منوی روزانه قیمت و ظرفیت پیش‌فرض خودکار پر می‌شود." actions={<Button onClick={() => { setErr(''); setForm({ ...empty }); }}><Plus className="ms-1 h-4 w-4" />غذای جدید</Button>} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1"><Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pr-9" placeholder="جست‌وجوی غذا" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select value={cat} onValueChange={setCat}><SelectTrigger className="sm:w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>همه‌ی دسته‌ها</SelectItem>{FOOD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm"><Switch checked={showInactive} onCheckedChange={setShowInactive} />نمایش غیرفعال‌ها</label>
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !foods.length ? <EmptyState title="غذایی پیدا نشد" text="اولین غذا را به کتابخانه اضافه کنید." /> : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">{faNum(foods.length)} غذا</p>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{foods.map((f) => <FoodCard key={f.id} f={f} onEdit={() => { setErr(''); setForm({ ...f, defaultPriceRial: f.defaultPriceRial == null ? '' : String(f.defaultPriceRial), defaultCapacity: f.defaultCapacity == null ? '' : String(f.defaultCapacity) }); }} />)}</div>
        </>
      )}
      <Dialog open={!!form} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent dir="rtl" className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{form?.id ? 'ویرایش غذا' : 'افزودن غذا به کتابخانه'}</DialogTitle><DialogDescription>غذاها حذف نمی‌شوند؛ برای خارج کردن از منو غیرفعالشان کنید.</DialogDescription></DialogHeader>
          {form && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2"><Label>نام غذا</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثلاً چلوخورش قیمه" /></div>
              <div className="space-y-1.5"><Label>دسته</Label><Select value={form.category || undefined} onValueChange={(v) => setForm({ ...form, category: v })}><SelectTrigger><SelectValue placeholder="انتخاب دسته" /></SelectTrigger><SelectContent>{FOOD_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>وعده‌های مناسب</Label><div className="flex gap-1.5">{Object.entries(MEALS).map(([k, v]) => <button type="button" key={k} onClick={() => toggleMeal(k)} className={cn('flex-1 rounded-lg border px-2 py-2 text-xs transition', form.suitableMeals.includes(k) ? 'border-primary bg-primary text-primary-foreground' : 'hover:border-primary/50')}>{v}</button>)}</div></div>
              <div className="space-y-1.5"><Label>قیمت پیش‌فرض (ریال)</Label><Input inputMode="numeric" dir="ltr" value={form.defaultPriceRial} onChange={(e) => setForm({ ...form, defaultPriceRial: e.target.value.replace(/\D/g, '') })} />{form.defaultPriceRial && <p className="text-xs text-muted-foreground">{rial(Number(form.defaultPriceRial))}</p>}</div>
              <div className="space-y-1.5"><Label>ظرفیت پیش‌فرض</Label><Input inputMode="numeric" dir="ltr" value={form.defaultCapacity} onChange={(e) => setForm({ ...form, defaultCapacity: e.target.value.replace(/\D/g, '') })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label>توضیحات (مواد، حساسیت‌زاها، ...)</Label><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
              <div className="space-y-1.5 sm:col-span-2"><Label>آدرس تصویر (اختیاری)</Label><Input dir="ltr" placeholder="https://..." value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value.trim() })} />
                {form.imageUrl && /^https:\/\//.test(form.imageUrl) ? <img src={form.imageUrl} alt="" className="mt-2 h-28 w-full rounded-lg object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} /> : form.imageUrl ? <p className="flex items-center gap-1 text-xs text-muted-foreground"><ImageOff className="h-3 w-3" />پیش‌نمایش در دسترس نیست</p> : null}</div>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">فعال<Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /></label>
              <label className="flex items-center justify-between rounded-lg border p-3 text-sm">نمایشی (آزمایشی)<Switch checked={form.isDemo} onCheckedChange={(v) => setForm({ ...form, isDemo: v })} /></label>
              <div className="sm:col-span-2"><ErrorNote message={err || (form.name ? formErr || '' : '')} /></div>
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setForm(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={busy || !!formErr}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
