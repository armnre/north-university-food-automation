import { useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, Minus, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { catalogList, catalogSave, uploadFoodImage } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Textarea } from '@project/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorNote, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { errMsg, faNum, tomanText } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { Catalog, Food } from '../../lib/types';

export const FOOD_CATEGORIES = ['خورشتی', 'پلویی', 'کبابی', 'سوخاری و فست‌فود', 'گیاهی', 'صبحانه', 'سایر'];
const CAT_EMOJI: Record<string, string> = {
  خورشتی: '🍲',
  پلویی: '🍛',
  کبابی: '🍢',
  'سوخاری و فست‌فود': '🍔',
  گیاهی: '🥗',
  صبحانه: '🍳',
  سایر: '🍽️',
};
const PRICE_CHIPS = [500000, 1000000, 2000000, 3000000];
const MAX_FOOD_IMAGE_BYTES = 2 * 1024 * 1024;

type Form = {
  id?: string;
  name: string;
  description: string;
  isActive: boolean;
  category: string;
  defaultPriceRial: string;
  defaultCapacity: string;
  calories: string;
  imagePath: string;
};

const empty: Form = {
  name: '',
  description: '',
  isActive: true,
  category: '',
  defaultPriceRial: '',
  defaultCapacity: '100',
  calories: '',
  imagePath: '',
};
const ALL = '__all__';

function FoodCard({ f, onEdit }: { f: Food; onEdit: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button
      onClick={onEdit}
      className={cn(
        'lift group flex flex-col overflow-hidden rounded-2xl border bg-card text-right shadow-[var(--shadow-sm)] active:scale-[0.98]',
        !f.isActive && 'opacity-55 grayscale',
      )}
    >
      <div className="relative aspect-[4/3] w-full bg-gradient-to-br from-accent to-muted">
        {f.imagePath && !imgFailed ? (
          <img
            src={f.imagePath}
            alt={f.name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="grid h-full place-items-center text-4xl">{CAT_EMOJI[f.category] ?? '🍽️'}</div>
        )}
        <div className="absolute inset-x-2 top-2 flex justify-between">
          {f.category ? (
            <span className="rounded-full bg-card/90 px-2 py-0.5 text-[10px] font-semibold shadow-sm backdrop-blur">
              {f.category}
            </span>
          ) : (
            <span />
          )}
          {!f.isActive ? <Pill tone="muted">غیرفعال</Pill> : null}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="truncate font-bold">{f.name}</span>
        <span className="text-[11px] text-muted-foreground">
          {f.calories ? `${faNum(f.calories)} کیلوکالری` : f.category || '—'}
        </span>
        <span className="num mt-auto pt-1 text-sm font-extrabold text-primary">
          {f.defaultPriceRial != null ? tomanText(f.defaultPriceRial) : '—'}
        </span>
      </div>
    </button>
  );
}

export default function FoodsPage() {
  const { data, error, loading, reload } = useLoad(async () => (await catalogList()) as Catalog);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(ALL);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const foods = useMemo(
    () =>
      (data?.foods ?? []).filter(
        (f) =>
          (showInactive || f.isActive) &&
          (cat === ALL || f.category === cat) &&
          (!q || f.name.includes(q) || f.description.includes(q)),
      ),
    [data, q, cat, showInactive],
  );
  const openNew = () => setForm({ ...empty });

  return (
    <>
      <PageHeader
        title="کتابخانه‌ی غذا"
        subtitle="هر غذا را یک‌بار بسازید، تصویر آن را بارگذاری کنید و در منوها استفاده کنید."
        actions={
          <Button className="hidden h-11 rounded-xl sm:inline-flex" onClick={openNew}>
            <Plus className="ms-1 h-4 w-4" />
            غذای جدید
          </Button>
        }
      />
      <div className="mb-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-3.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-11 rounded-xl pr-9"
              placeholder="جست‌وجوی غذا"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <label className="flex h-11 items-center gap-2 whitespace-nowrap rounded-xl border bg-card px-3 text-xs">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} />
            غیرفعال‌ها
          </label>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
          {[ALL, ...FOOD_CATEGORIES].map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={cn(
                'h-11 shrink-0 rounded-full border px-3.5 text-xs font-medium transition active:scale-95',
                cat === c ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground',
              )}
            >
              {c === ALL ? 'همه' : `${CAT_EMOJI[c]} ${c}`}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !foods.length ? (
        <EmptyState
          title="غذایی پیدا نشد"
          text="اولین غذا را به کتابخانه اضافه کنید."
          action={
            <Button onClick={openNew}>
              <Plus className="ms-1 h-4 w-4" />
              غذای جدید
            </Button>
          }
        />
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {faNum(foods.length)} غذا · برای ویرایش روی هر کارت بزنید
          </p>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            <button
              onClick={openNew}
              className="hidden flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-muted-foreground transition hover:border-primary hover:text-primary sm:flex"
            >
              <Plus className="h-7 w-7" />
              <span className="text-sm font-semibold">غذای جدید</span>
            </button>
            {foods.map((f) => (
              <FoodCard
                key={f.id}
                f={f}
                onEdit={() =>
                  setForm({
                    id: f.id,
                    name: f.name,
                    description: f.description,
                    isActive: f.isActive,
                    category: f.category,
                    calories: f.calories == null ? '' : String(f.calories),
                    defaultPriceRial: f.defaultPriceRial == null ? '' : String(f.defaultPriceRial),
                    defaultCapacity: f.defaultCapacity == null ? '' : String(f.defaultCapacity),
                    imagePath: f.imagePath ?? '',
                  })
                }
              />
            ))}
          </div>
        </>
      )}
      <button
        onClick={openNew}
        aria-label="غذای جدید"
        className="fixed bottom-24 left-5 z-30 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-[var(--shadow-xl)] active:scale-95 sm:hidden"
      >
        <Plus className="h-6 w-6" />
      </button>
      <FoodEditor form={form} setForm={setForm} onSaved={reload} />
    </>
  );
}

function FoodEditor({
  form,
  setForm,
  onSaved,
}: {
  form: Form | null;
  setForm: (f: Form | null) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const formErr =
    form &&
    (form.name.trim().length < 2
      ? 'نام غذا را وارد کنید'
      : form.imagePath && !/^(https:\/\/|\/)/.test(form.imagePath)
        ? 'آدرس تصویر باید با / یا https شروع شود'
        : '');

  const close = () => {
    if (!busy && !uploading) {
      setErr('');
      setForm(null);
    }
  };
  const set = (p: Partial<Form>) => form && setForm({ ...form, ...p });
  const cap = Number(form?.defaultCapacity || 0);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !form) return;

    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
      setErr('فقط فرمت‌های JPEG، PNG و WebP مجاز هستند.');
      return;
    }
    if (file.size > MAX_FOOD_IMAGE_BYTES) {
      setErr('حجم تصویر انتخاب‌شده بیشتر از ۲ مگابایت است.');
      return;
    }

    setUploading(true);
    setErr('');
    try {
      const res = await uploadFoodImage(file);
      set({ imagePath: res.url });
      toast.success('تصویر غذا بارگذاری و بهینه‌سازی شد.');
    } catch (uploadError) {
      setErr(errMsg(uploadError));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!form || formErr || uploading) return;
    setBusy(true);
    setErr('');
    try {
      await catalogSave({
        item: {
          kind: 'food',
          id: form.id,
          name: form.name.trim(),
          description: form.description,
          isActive: form.isActive,
          category: form.category,
          calories: form.calories ? Number(form.calories) : null,
          defaultPriceRial: form.defaultPriceRial ? Number(form.defaultPriceRial) : null,
          defaultCapacity: form.defaultCapacity ? Number(form.defaultCapacity) : null,
          imagePath: form.imagePath || undefined,
        },
      });
      toast.success(form.id ? 'غذا به‌روزرسانی شد.' : 'غذا به کتابخانه اضافه شد.');
      setForm(null);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!form} onOpenChange={(o) => !o && close()}>
      <DialogContent
        dir="rtl"
        className="flex h-[100dvh] max-h-[100dvh] max-w-full flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-3xl [&>button]:hidden"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <button
            onClick={close}
            aria-label="بستن"
            className="grid h-11 w-11 place-items-center rounded-full hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
          <DialogTitle className="text-base font-bold">{form?.id ? 'ویرایش غذا' : 'غذای جدید'}</DialogTitle>
          <span className="w-11" />
        </div>
        <DialogDescription className="sr-only">ویرایش اطلاعات غذا</DialogDescription>
        {form && (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
              <Label>تصویر غذا (اختیاری)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => void onPickFile(e)}
                disabled={uploading || busy}
              />
              {form.imagePath ? (
                <div className="relative overflow-hidden rounded-2xl border bg-muted/40">
                  <div className="aspect-[16/9] w-full">
                    <img src={form.imagePath} alt="پیش‌نمایش تصویر غذا" className="h-full w-full object-cover" />
                  </div>
                  <div className="absolute left-2 top-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || busy}
                      className="flex h-11 items-center gap-1.5 rounded-full bg-card/90 px-3.5 text-xs font-semibold shadow backdrop-blur"
                    >
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      تغییر تصویر
                    </button>
                    <button
                      type="button"
                      onClick={() => set({ imagePath: '' })}
                      disabled={uploading || busy}
                      className="grid h-11 w-11 place-items-center rounded-full bg-card/90 text-destructive shadow backdrop-blur"
                      aria-label="حذف تصویر"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || busy}
                  className="flex min-h-[116px] w-full flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed bg-muted/30 p-4 text-center transition hover:border-primary hover:bg-primary/5 disabled:opacity-60"
                >
                  {uploading ? (
                    <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  ) : (
                    <ImagePlus className="h-7 w-7 text-primary" />
                  )}
                  <span className="text-sm font-semibold">
                    {uploading ? 'در حال بارگذاری و بهینه‌سازی تصویر…' : 'انتخاب تصویر از گوشی یا رایانه'}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    فرمت JPG، PNG یا WebP · حداکثر ۲ مگابایت · تغییر اندازه و حذف خودکار متادیتا
                  </span>
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="food-name">نام غذا</Label>
              <Input
                id="food-name"
                className="h-12 rounded-xl text-base"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="مثلاً چلوخورش قیمه"
              />
            </div>

            <div className="space-y-2">
              <Label>دسته</Label>
              <div className="flex flex-wrap gap-2">
                {FOOD_CATEGORIES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => set({ category: c })}
                    className={cn(
                      'h-11 rounded-full border px-3.5 text-xs font-medium transition',
                      form.category === c ? 'border-primary bg-primary text-primary-foreground' : 'bg-card',
                    )}
                  >
                    {CAT_EMOJI[c]} {c}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="food-calories">کالری (اختیاری)</Label>
              <Input
                id="food-calories"
                className="h-12 rounded-xl text-base"
                inputMode="numeric"
                dir="ltr"
                value={form.calories ?? ''}
                onChange={(e) => set({ calories: e.target.value.replace(/[^0-9]/g, '') })}
                placeholder="مثلاً ۷۵۰"
              />
            </div>

            <div className="space-y-2">
              <Label>قیمت پیش‌فرض (ریال — نمایش به تومان)</Label>
              <Input
                className="h-12 rounded-xl text-base"
                inputMode="numeric"
                dir="ltr"
                value={form.defaultPriceRial}
                onChange={(e) => set({ defaultPriceRial: e.target.value.replace(/\D/g, '') })}
              />
              {form.defaultPriceRial && (
                <p className="num text-xs font-semibold text-primary">{tomanText(Number(form.defaultPriceRial))}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {PRICE_CHIPS.map((p) => (
                  <button
                    type="button"
                    key={p}
                    onClick={() => set({ defaultPriceRial: String(p) })}
                    className="num min-h-9 rounded-lg bg-muted px-3 py-1.5 text-[11px]"
                  >
                    {tomanText(p)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>ظرفیت پیش‌فرض</Label>
              <div className="flex h-12 items-center justify-between rounded-xl border bg-card px-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-11 w-11"
                  aria-label="افزایش ظرفیت"
                  onClick={() => set({ defaultCapacity: String(cap + 10) })}
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <input
                  aria-label="ظرفیت پیش‌فرض"
                  className="w-24 bg-transparent text-center text-lg font-bold outline-none"
                  inputMode="numeric"
                  dir="ltr"
                  value={form.defaultCapacity}
                  onChange={(e) => set({ defaultCapacity: e.target.value.replace(/\D/g, '') })}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-11 w-11"
                  aria-label="کاهش ظرفیت"
                  onClick={() => set({ defaultCapacity: String(Math.max(cap - 10, 0)) })}
                >
                  <Minus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="food-desc">توضیحات (مواد، حساسیت‌زاها)</Label>
              <Textarea
                id="food-desc"
                className="rounded-xl"
                rows={3}
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            </div>

            <div className="divide-y rounded-2xl border">
              <label className="flex items-center justify-between p-3.5 text-sm">
                فعال و قابل استفاده در منو
                <Switch checked={form.isActive} onCheckedChange={(v) => set({ isActive: v })} />
              </label>
            </div>
            <ErrorNote message={err} onClose={() => setErr('')} />
          </div>
        )}
        <div className="border-t bg-card px-5 py-3 pb-safe">
          <Button
            className="h-12 w-full rounded-2xl text-base font-bold"
            onClick={save}
            disabled={busy || uploading || !!formErr}
          >
            {busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}
            {formErr || 'ذخیره'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
