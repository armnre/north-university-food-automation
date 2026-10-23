import { useEffect, useState } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { SETTINGS_META, toAsciiDigits, validateSettingValue, type SettingKey } from '@food/shared';
import { settingsManage, type SettingsPayload } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { ErrorNote, ErrorState, LoadingBlock, PageHeader, Pill, Section } from '../../components/ui-kit';
import { errMsg, faDateTime, faDigits } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

const NUMERIC_KEYS: SettingKey[] = [
  'reminder_hours_before_meal',
  'noshow_grace_minutes',
  'scan_window_before_minutes',
  'scan_window_after_minutes',
];

const TEXT_FIELDS: [SettingKey, string, string][] = [
  ['supportText', 'اطلاعات تماس پشتیبانی', 'در صفحه‌ی «راهنما و پشتیبانی» دانشجو نمایش داده می‌شود.'],
  ['helpText', 'متن راهنمای دانشجو', 'اگر خالی باشد، راهنمای پیش‌فرض نمایش داده می‌شود.'],
  ['reservationPolicyNote', 'سیاست مصوب رزرو', 'متن مصوب دانشگاه برای ثبت در سامانه (مرجع داخلی).'],
  ['cancellationPolicyNote', 'سیاست مصوب لغو و بازپرداخت', 'شامل سیاست بازگشت وجه و وضعیت «عدم مراجعه».'],
];

const UNIT_FA: Record<string, string> = {
  hours: 'ساعت',
  minutes: 'دقیقه',
  rial: 'ریال',
};

const JOB_LABELS_FA: Record<string, string> = {
  'mark-no-shows': 'ثبت عدم مراجعهٔ وعده‌های گذشته',
  'send-meal-reminders': 'ارسال یادآوری وعده (درون‌برنامه‌ای + پیامک)',
  'reconcile-payments': 'تعیین‌تکلیف پرداخت‌های معلق درگاه',
  'cleanup-captchas': 'پاک‌سازی کپچاهای منقضی',
  'cleanup-sessions': 'پاک‌سازی نشست‌های منقضی',
  'purge-login-attempts': 'پاک‌سازی لاگ تلاش‌های ورود قدیمی',
  'cleanup-import-rows': 'پاک‌سازی پیش‌نمایش‌های واردسازی اکسل',
  'reconcile-ledger': 'ممیزی تراز دفتر کل دوطرفه',
  'drain-sms-outbox': 'ارسال صف پیامک (Outbox)',
};

export default function SettingsPage() {
  const { data, error, loading, reload } = useLoad<SettingsPayload>(() => settingsManage());
  const [v, setV] = useState<Record<string, string> | null>(null);
  const [validationError, setValidationError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data?.values) {
      const next: Record<string, string> = {};
      for (const key of [...NUMERIC_KEYS, ...TEXT_FIELDS.map((f) => f[0])]) {
        next[key] = data.values[key] ?? SETTINGS_META[key].defaultValue;
      }
      setV(next);
    }
  }, [data]);

  const save = async () => {
    if (!v) return;
    setValidationError('');

    const payload: Record<string, string> = {};
    for (const key of [...NUMERIC_KEYS, ...TEXT_FIELDS.map((f) => f[0])]) {
      const rawVal = NUMERIC_KEYS.includes(key) ? toAsciiDigits(v[key] ?? '').trim() : (v[key] ?? '');
      const check = validateSettingValue(key, rawVal);
      if (!check.ok) {
        setValidationError(check.messageFa);
        toast.error(check.messageFa);
        return;
      }
      payload[key] = check.value;
    }

    setBusy(true);
    try {
      await settingsManage({ values: payload });
      toast.success('تنظیمات سامانه با موفقیت ذخیره شد.');
      reload();
    } catch (e) {
      const msg = errMsg(e);
      setValidationError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !v) return <LoadingBlock />;
  if (error || !v) return <ErrorState message={error ?? ''} onRetry={reload} />;

  return (
    <>
      <PageHeader
        title="تنظیمات سیستم و زمان‌بندی کارها"
        actions={
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}
            ذخیره‌ی تنظیمات
          </Button>
        }
      />

      {validationError && (
        <div className="mb-4">
          <ErrorNote message={validationError} onClose={() => setValidationError('')} />
        </div>
      )}

      <Section title="پارامترهای زمانی تحویل و یادآوری وعده" className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {NUMERIC_KEYS.map((key) => {
            const meta = SETTINGS_META[key];
            const unitLabel = meta.unit ? UNIT_FA[meta.unit] ?? meta.unit : '';
            return (
              <div key={key} className="space-y-1.5 rounded-xl border p-3.5">
                <Label htmlFor={`setting-${key}`} className="font-semibold">
                  {meta.labelFa}
                  {unitLabel ? ` (${unitLabel})` : ''}
                </Label>
                <p className="text-xs text-muted-foreground">{meta.descriptionFa}</p>
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    id={`setting-${key}`}
                    type="number"
                    dir="ltr"
                    min={meta.min}
                    max={meta.max}
                    className="max-w-[160px] font-mono"
                    value={v[key] ?? ''}
                    onChange={(e) => setV({ ...v, [key]: e.target.value })}
                  />
                  {meta.min !== undefined && meta.max !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      بازهٔ مجاز: {faDigits(String(meta.min))} تا {faDigits(String(meta.max))} {unitLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        {TEXT_FIELDS.map(([k, label, hint]) => (
          <Section key={k}>
            <Label htmlFor={k}>{label}</Label>
            <p className="mb-2 mt-1 text-xs text-muted-foreground">{hint}</p>
            <Textarea id={k} rows={5} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </Section>
        ))}

        <Section title="آخرین وضعیت کارهای پس‌زمینه (food-worker)" className="lg:col-span-2">
          {!data?.jobRuns?.length ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              هنوز اجرایی در جدول کارهای پس‌زمینه ثبت نشده است.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">کار زمان‌بندی‌شده</TableHead>
                    <TableHead className="text-right">وضعیت</TableHead>
                    <TableHead className="text-right">آخرین اجرا</TableHead>
                    <TableHead className="text-right">گزارش</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.jobRuns.map((jr) => (
                    <TableRow key={jr.job}>
                      <TableCell className="text-xs font-medium">{JOB_LABELS_FA[jr.job] ?? jr.job}</TableCell>
                      <TableCell>
                        <Pill tone={jr.status === 'Ok' ? 'success' : jr.status === 'Failed' ? 'danger' : 'warning'}>{jr.status}</Pill>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{faDateTime(jr.startedAt)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{jr.message || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>

        <Section title="سیاست‌های ثابت فعلی سامانه" className="lg:col-span-2">
          <ul className="list-disc space-y-1.5 pr-5 text-sm text-muted-foreground">
            <li>رزرو چند غذای مختلف در یک وعده مجاز است؛ رزرو تکراری همان غذا مجاز نیست.</li>
            <li>مهلت رزرو برای هر وعده در «منو، وعده و ظرفیت» تعیین می‌شود.</li>
            <li>امکان لغو رزرو توسط دانشجو در نسخهٔ فعلی فعال نیست؛ لغو اداری با ذکر دلیل و بازپرداخت کامل به اعتبار داخلی انجام می‌شود.</li>
            <li>رزروی که تا پایان بازهٔ وعده تحویل نشود «عدم مراجعه» محسوب می‌شود (مستند کامل تصمیم‌ها در docs/DECISIONS.md).</li>
            <li>پرداخت سفارش از طریق درگاه بانکی (با کسر خودکار اعتبار داخلی موجود) انجام می‌شود و موجودی منفی مجاز نیست.</li>
          </ul>
        </Section>
      </div>
    </>
  );
}
