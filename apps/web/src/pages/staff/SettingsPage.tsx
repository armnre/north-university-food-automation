import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { settingsManage } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { ErrorState, LoadingBlock, PageHeader, Section } from '../../components/ui-kit';
import { errMsg } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

type V = { supportText: string; helpText: string; reservationPolicyNote: string; cancellationPolicyNote: string };
const FIELDS: [keyof V, string, string][] = [
  ['supportText', 'اطلاعات تماس پشتیبانی', 'در صفحه‌ی «راهنما و پشتیبانی» دانشجو نمایش داده می‌شود.'],
  ['helpText', 'متن راهنمای دانشجو', 'اگر خالی باشد، راهنمای پیش‌فرض نمایش داده می‌شود.'],
  ['reservationPolicyNote', 'سیاست مصوب رزرو', 'متن مصوب دانشگاه برای ثبت در سامانه (مرجع داخلی).'],
  ['cancellationPolicyNote', 'سیاست مصوب لغو و بازپرداخت', 'تا تصویب سیاست جریمه، لغو در مهلت با بازپرداخت کامل انجام می‌شود.'],
];

export default function SettingsPage() {
  const { data, error, loading, reload } = useLoad(async () => ((await settingsManage({})) as unknown as { values: V }).values);
  const [v, setV] = useState<V | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setV(data); }, [data]);
  const save = async () => {
    if (!v) return;
    setBusy(true);
    try { await settingsManage({ values: v }); toast.success('تنظیمات ذخیره شد.'); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  if (loading && !v) return <LoadingBlock />;
  if (error || !v) return <ErrorState message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <PageHeader title="تنظیمات سیستم" actions={<Button onClick={save} disabled={busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره‌ی تنظیمات</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        {FIELDS.map(([k, label, hint]) => (
          <Section key={k}>
            <Label htmlFor={k}>{label}</Label>
            <p className="mb-2 mt-1 text-xs text-muted-foreground">{hint}</p>
            <Textarea id={k} rows={5} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </Section>
        ))}
        <Section title="سیاست‌های ثابت فعلی سامانه" className="lg:col-span-2">
          <ul className="list-disc space-y-1.5 pr-5 text-sm text-muted-foreground">
            <li>هر دانشجو در هر وعده‌ی هر روز فقط یک رزرو فعال دارد.</li>
            <li>مهلت رزرو و لغو برای هر وعده جداگانه در «منو، وعده و ظرفیت» تعیین می‌شود.</li>
            <li>لغو در مهلت مجاز: بازپرداخت کامل مبلغ ثبت‌شده در لحظه‌ی رزرو. سیاست جریمه تعریف نشده است.</li>
            <li>رزروی که تا پایان روز وعده تحویل نشود «منقضی / عدم مراجعه» محسوب می‌شود و بازپرداختی ندارد.</li>
            <li>موجودی منفی کیف پول مجاز نیست. پرداخت اینترنتی غیرفعال است.</li>
          </ul>
        </Section>
      </div>
    </>
  );
}
