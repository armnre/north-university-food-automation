import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { settingsManage } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Textarea } from '@project/components/ui/textarea';
import { ErrorState, LoadingBlock, PageHeader, Section } from '../../components/ui-kit';
import { errMsg, MEALS } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

type Values = Record<string, boolean | number | string>;
type Slot = { code: 'breakfast' | 'lunch' | 'dinner'; title: string; startTime: string; endTime: string };
type Data = { values: Values; mealSlots: Slot[] };

const TOGGLES: [string, string, string][] = [
  ['student_cancellation_enabled', 'لغو رزرو توسط دانشجو', 'اگر خاموش باشد فقط کارکنان می‌توانند رزرو را لغو کنند.'],
  ['online_payment_enabled', 'پرداخت اینترنتی (زرین‌پال)', 'خاموش: خرید فقط با موجودی کیف پول.'],
  ['noshow_refund', 'بازپرداخت عدم مراجعه', 'رزرو تحویل‌نشده پس از پایان وعده بازپرداخت شود.'],
];
const NUMBERS: [string, string, string][] = [
  ['cancel_cutoff_hours', 'مهلت لغو (ساعت پیش از وعده)', '۰ تا ۱۶۸'],
  ['noshow_grace_minutes', 'مهلت عدم مراجعه (دقیقه پس از وعده)', '۰ تا ۲۴۰'],
  ['scan_window_before_minutes', 'اسکن از چند دقیقه قبل از وعده', '۰ تا ۲۴۰'],
  ['scan_window_after_minutes', 'اسکن تا چند دقیقه پس از وعده', '۰ تا ۲۴۰'],
  ['reminderHoursBeforeMeal', 'یادآوری (ساعت پیش از وعده)', '۰ تا ۴۸'],
  ['min_gateway_payable_rial', 'حداقل مبلغ پرداخت اینترنتی (ریال)', 'حداقل ۱۰٬۰۰۰'],
  ['max_manual_adjust_rial', 'سقف تعدیل دستی (ریال)', 'هر عملیات شارژ/برداشت دستی'],
];
const TEXTS: [string, string, string][] = [
  ['support_text', 'اطلاعات تماس پشتیبانی', 'در صفحه‌ی «راهنما و پشتیبانی» نمایش داده می‌شود.'],
  ['help_text', 'متن راهنما', 'اگر خالی باشد، راهنمای پیش‌فرض نمایش داده می‌شود.'],
  ['policy_text', 'سیاست مصوب رزرو و لغو', 'متن مصوب دانشگاه برای نمایش به کاربران.'],
];

export default function SettingsPage() {
  const { data, error, loading, reload } = useLoad(async () => (await settingsManage()) as Data);
  const [v, setV] = useState<Values | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setV(data.values); setSlots(data.mealSlots); } }, [data]);
  const save = async () => {
    if (!v) return;
    if (slots.some((s) => s.startTime >= s.endTime)) return toast.error('ساعت شروع هر وعده باید قبل از پایان آن باشد.');
    setBusy(true);
    try { await settingsManage({ values: v, mealSlots: slots.map(({ code, startTime, endTime }) => ({ code, startTime, endTime })) }); toast.success('تنظیمات ذخیره شد.'); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  if (loading && !v) return <LoadingBlock />;
  if (error || !v) return <ErrorState message={error ?? ''} onRetry={reload} />;
  const set = (k: string, val: boolean | number | string) => setV({ ...v, [k]: val });
  return (
    <>
      <PageHeader title="تنظیمات سیستم" subtitle="هر تغییر با نام شما در رخدادهای ممیزی ثبت می‌شود." actions={<Button onClick={save} disabled={busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره‌ی تنظیمات</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="سیاست‌ها">
          <div className="space-y-4">
            {TOGGLES.map(([k, label, hint]) => (
              <label key={k} className="flex items-start justify-between gap-4">
                <span><span className="text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                <Switch checked={!!v[k]} onCheckedChange={(c) => set(k, c)} />
              </label>
            ))}
          </div>
        </Section>
        <Section title="ساعت وعده‌ها">
          <div className="space-y-3">
            {slots.map((s, i) => (
              <div key={s.code} className="grid grid-cols-[5rem_1fr_1fr] items-center gap-2">
                <span className="text-sm font-medium">{s.title || MEALS[s.code[0].toUpperCase() + s.code.slice(1)]}</span>
                <Input type="time" dir="ltr" aria-label="شروع" value={s.startTime} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)))} />
                <Input type="time" dir="ltr" aria-label="پایان" value={s.endTime} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, endTime: e.target.value } : x)))} />
              </div>
            ))}
          </div>
        </Section>
        <Section title="زمان‌ها و مبالغ" className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {NUMBERS.map(([k, label, hint]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={k}>{label}</Label>
                <Input id={k} dir="ltr" inputMode="numeric" value={String(v[k] ?? '')} onChange={(e) => set(k, Number(e.target.value.replace(/\D/g, '') || 0))} />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </div>
        </Section>
        {TEXTS.map(([k, label, hint]) => (
          <Section key={k} className={k === 'policy_text' ? 'lg:col-span-2' : ''}>
            <Label htmlFor={k}>{label}</Label>
            <p className="mb-2 mt-1 text-xs text-muted-foreground">{hint}</p>
            <Textarea id={k} rows={5} value={String(v[k] ?? '')} onChange={(e) => set(k, e.target.value)} />
          </Section>
        ))}
      </div>
    </>
  );
}
