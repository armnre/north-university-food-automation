import { useMemo, useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { importCancel, importCommit, importList, importPreview } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Progress } from '@project/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@project/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@project/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { cn } from '@project/components/lib/utils';
import { PageHeader, Pill, Section, StatCard } from '../../components/ui-kit';
import { downloadCsv, errMsg, faDateTime, faNum } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 25000;
type ImportCommitResult = { batchId: string; status: string; written: number; created: number; updated: number; removed: number; conflictsSkipped: number; sessionsRevoked: number; replay: boolean };
type Preview = {
  batchId: string; summary: { total: number; valid: number; errors: number; new: number; changed: number; unchanged: number; returning: number; conflicts: number; removed: number }; duplicateOfCommitted: boolean; blocked: boolean;
  conflicts: { rowNumber: number; studentNumber: string; fullName: string }[];
  removed: { id: string; studentNumber: string; fullName: string; faculty: string; major: string; status: string }[]; massRemovalWarning: boolean;
  rows: { rowNumber: number; studentNumber: string; fullName: string; faculty: string; major: string; kind: string; errors: string[]; changes: string[] }[];
  errorReport: { rowNumber: number; studentNumber: string; errors: string[] }[];
};
const KIND: Record<string, string> = { error: 'خطا', new: 'جدید', changed: 'تغییر', unchanged: 'بدون تغییر', returning: 'بازگشتی', conflict: 'تعارض کد ملی' };
const STEPS = ['انتخاب فایل', 'تنظیمات', 'پیش‌نمایش و بررسی', 'گزارش نهایی'];

export default function ImportPage() {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [policy, setPolicy] = useState<'RejectAllOnError' | 'SkipInvalidRows'>('RejectAllOnError');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fullSync, setFullSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'new' | 'changed' | 'returning' | 'conflict' | 'removed'>('all');
  const [approved, setApproved] = useState<number[]>([]);
  const history = useLoad(async () => (await importList()) as { batches: { id: string; fileName: string; status: string; totalRows: number; validRows: number; errorRows: number; newRows: number; changedRows: number; errorReport: string; createdAt: string; uploadedBy: string }[] });

  const reset = () => { setStep(0); setFile(null); setPreview(null); setResult(null); setApproved([]); };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { toast.error('فقط فایل xlsx مجاز است (xls و csv پذیرفته نمی‌شوند).'); return; }
    if (f.size > MAX_BYTES) { toast.error('حجم فایل بیش از ۲۰ مگابایت است.'); return; }
    setFile(f); setStep(1);
  };

  const runPreview = async () => {
    setBusy(true);
    try { setPreview((await importPreview(file!, { policy, fullSync })) as unknown as Preview); setStep(2); history.reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const commit = async () => {
    setConfirmOpen(false); setBusy(true);
    try {
      const r = (await importCommit({ batchId: preview!.batchId, approvedConflicts: approved })) as unknown as ImportCommitResult;
      setResult(r); setStep(3);
      toast.success(`واردسازی انجام شد: ${faNum(r.created + r.updated)} ردیف.`);
      history.reload();
    }
    catch (e) { toast.error(errMsg(e)); history.reload(); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (preview) await importCancel({ batchId: preview.batchId }).catch(() => undefined);
    toast('عملیات واردسازی لغو شد.'); reset(); history.reload();
  };
  const downloadErrors = (rows: { rowNumber: number; studentNumber: string; errors: string[] }[], name: string) =>
    downloadCsv(name, ['شماره ردیف', 'شماره دانشجویی', 'خطاها'], rows.map((r) => [r.rowNumber, r.studentNumber, r.errors.join(' | ')]));

  const shown = useMemo(() => (preview?.rows ?? []).filter((r) => filter === 'all' || r.kind === filter), [preview, filter]);

  return (
    <>
      <PageHeader title="واردسازی اطلاعات دانشجویان" subtitle="بارگذاری ← بررسی ← پیش‌نمایش ← تأیید ← ثبت ← گزارش" />
      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s} className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', i === step ? 'border-primary bg-secondary font-semibold' : i < step ? 'text-primary' : 'text-muted-foreground')}>
            <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs', i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{faNum(i + 1)}</span>{s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Section>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center hover:border-primary/50 hover:bg-secondary/40">
            <Upload className="h-10 w-10 text-primary" />
            <span className="mt-3 font-semibold">فایل Excel معاونت را انتخاب کنید</span>
            <span className="mt-1 text-sm text-muted-foreground">فقط فایل xlsx · حداکثر ۲۰ مگابایت · حداکثر {faNum(MAX_ROWS)} ردیف · ردیف اول باید عنوان ستون‌ها باشد</span>
            <input type="file" className="sr-only" accept=".xlsx" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <p className="mt-4 text-xs text-muted-foreground">ستون‌های الزامی: شماره دانشجویی، کد ملی و نام (یا نام و نام خانوادگی جداگانه). ستون‌های اختیاری: دانشکده، رشته، مقطع، سال ورود.</p>
        </Section>
      )}

      {step === 1 && file && (
        <Section title="تنظیمات واردسازی" actions={<span className="text-sm text-muted-foreground"><FileSpreadsheet className="ms-1 inline h-4 w-4" />{file.name} · {faNum(Math.round(file.size / 1024))} KB</span>}>
          <p className="mb-4 text-sm text-muted-foreground">
            فایل در سمت سرور بررسی می‌شود. ستون‌های «شماره دانشجویی»، «نام و نام خانوادگی» و «کد ملی» به‌صورت خودکار شناسایی می‌شوند؛
            ستون‌های دانشکده، رشته، مقطع و سال ورود اختیاری‌اند.
          </p>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>سیاست برخورد با ردیف‌های خطادار</Label>
              <RadioGroup value={policy} onValueChange={(v) => setPolicy(v as typeof policy)}>
                <label className="flex items-start gap-2 rounded-xl border bg-card p-3 text-sm">
                  <RadioGroupItem value="RejectAllOnError" className="mt-0.5" />
                  <span><span className="font-semibold">رد کردن همه</span><span className="block text-xs text-muted-foreground">اگر حتی یک ردیف خطا داشته باشد، هیچ داده‌ای وارد نمی‌شود.</span></span>
                </label>
                <label className="flex items-start gap-2 rounded-xl border bg-card p-3 text-sm">
                  <RadioGroupItem value="SkipInvalidRows" className="mt-0.5" />
                  <span><span className="font-semibold">رد کردن ردیف‌های خطادار</span><span className="block text-xs text-muted-foreground">ردیف‌های سالم وارد و گزارش خطاها برای اصلاح دانلود می‌شود.</span></span>
                </label>
              </RadioGroup>
            </div>
            <label className="flex items-center justify-between rounded-xl border bg-card p-3.5 text-sm">
              <span>
                <span className="font-semibold">همگام‌سازی کامل فهرست (fullSync)</span>
                <span className="block text-xs text-muted-foreground">دانشجویانی که در این فایل نیستند، از فهرست فعال خارج می‌شوند (حذف فیزیکی نمی‌شوند).</span>
              </span>
              <Switch checked={fullSync} onCheckedChange={setFullSync} />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={reset} disabled={busy}>بازگشت</Button>
              <Button onClick={runPreview} disabled={busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}بررسی و پیش‌نمایش</Button>
            </div>
          </div>
        </Section>
      )}

      {step === 2 && preview && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <StatCard label="کل ردیف‌ها" value={faNum(preview.summary.total)} />
            <StatCard label="معتبر" value={faNum(preview.summary.valid)} />
            <StatCard label="دارای خطا" value={faNum(preview.summary.errors)} />
            <StatCard label="دانشجوی جدید" value={faNum(preview.summary.new)} />
            <StatCard label="تغییر اطلاعات" value={faNum(preview.summary.changed)} hint={`${faNum(preview.summary.unchanged)} بدون تغییر`} />
            <StatCard label="بازگشتی" value={faNum(preview.summary.returning)} hint="قبلاً حذف شده بودند" />
            <StatCard label="حذف از فهرست" value={faNum(preview.summary.removed)} hint="در فایل جدید نیستند" />
          </div>
          {preview.massRemovalWarning && <div className="mt-4 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle className="h-5 w-5 shrink-0" />هشدار: بیش از ۳۰٪ دانشجویان فعلی در این فایل نیستند و حذف خواهند شد. مطمئن شوید فایل کامل است.</div>}
          {preview.duplicateOfCommitted && <div className="mt-4 flex gap-2 rounded-lg border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] p-3 text-sm"><AlertTriangle className="h-5 w-5 text-[hsl(var(--warning))]" />این فایل با محتوای یکسان قبلاً یک‌بار واردسازی شده است.</div>}
          {preview.blocked && <div className="mt-4 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle className="h-5 w-5" />طبق سیاست «رد کامل»، تا رفع خطاها امکان ثبت وجود ندارد. گزارش خطا را دانلود و فایل را اصلاح کنید.</div>}
          <Section className="mt-4" title="پیش‌نمایش" actions={
            <div className="flex flex-wrap gap-2">
              <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}><SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">همه</SelectItem><SelectItem value="error">دارای خطا</SelectItem><SelectItem value="new">جدید</SelectItem><SelectItem value="changed">تغییریافته</SelectItem><SelectItem value="returning">بازگشتی</SelectItem><SelectItem value="removed">حذف از فهرست</SelectItem></SelectContent></Select>
              {preview.errorReport.length > 0 && <Button size="sm" variant="outline" onClick={() => downloadErrors(preview.errorReport, 'import-errors.csv')}><Download className="ms-1 h-4 w-4" />گزارش خطا</Button>}
              <Button size="sm" variant="outline" onClick={() => downloadCsv('import-diff.csv', ['نتیجه', 'شماره دانشجویی', 'نام', 'رشته', 'جزئیات'], [...preview.rows.map((r) => [KIND[r.kind] ?? r.kind, r.studentNumber, r.fullName, r.major, r.errors.join(' | ') || r.changes.join('، ')]), ...preview.removed.map((m) => ['حذف از فهرست', m.studentNumber, m.fullName, m.major, ''])])}><Download className="ms-1 h-4 w-4" />گزارش مغایرت</Button>
            </div>
          }>
            <div className="max-h-[460px] overflow-auto rounded-lg border">
              <Table>
                <TableHeader><TableRow><TableHead className="text-right">ردیف</TableHead><TableHead className="text-right">شماره دانشجویی</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="hidden text-right md:table-cell">رشته</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead className="text-right">جزئیات</TableHead></TableRow></TableHeader>
                <TableBody>
                  {filter === 'removed' ? preview.removed.slice(0, 500).map((m) => (
                    <TableRow key={m.id} className="bg-destructive/5"><TableCell>—</TableCell><TableCell className="num">{m.studentNumber}</TableCell><TableCell>{m.fullName}</TableCell><TableCell className="hidden md:table-cell">{m.major}</TableCell><TableCell><Pill tone="danger">حذف از فهرست</Pill></TableCell><TableCell className="text-xs text-muted-foreground">در فایل جدید وجود ندارد</TableCell></TableRow>
                  )) : shown.slice(0, 500).map((r) => (
                    <TableRow key={r.rowNumber} className={r.kind === 'error' ? 'bg-destructive/5' : ''}>
                      <TableCell className="num">{faNum(r.rowNumber)}</TableCell><TableCell className="num">{r.studentNumber}</TableCell><TableCell>{r.fullName}</TableCell><TableCell className="hidden md:table-cell">{r.major}</TableCell>
                      <TableCell><Pill tone={r.kind === 'error' ? 'danger' : r.kind === 'new' ? 'success' : r.kind === 'changed' ? 'warning' : r.kind === 'returning' ? 'info' : 'muted'}>{KIND[r.kind]}</Pill></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.errors.join('، ') || (r.changes.length ? `تغییر: ${r.changes.join('، ')}` : '')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
          {busy && <Progress className="mt-4" value={66} />}
          <div className="mt-4 flex justify-between gap-2">
            <Button variant="outline" onClick={cancel} disabled={busy}>لغو واردسازی</Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={busy || preview.blocked || preview.summary.new + preview.summary.changed + preview.summary.returning + preview.summary.removed === 0}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}تأیید نهایی و ثبت</Button>
          </div>
        </>
      )}

      {step === 3 && result && preview && (
        <Section>
          <div className="flex flex-col items-center py-8 text-center">
            <CheckCircle2 className="h-14 w-14 text-[hsl(var(--success))]" />
            <h2 className="mt-3 text-xl font-bold">واردسازی کامل شد</h2>
            <p className="mt-2 text-muted-foreground">{faNum(result.written)} رکورد ثبت/به‌روزرسانی شد · {faNum(result.removed ?? 0)} دانشجو از فهرست حذف شد · {faNum(preview.summary.errors)} ردیف خطادار کنار گذاشته شد.</p>
            <div className="mt-5 flex gap-2">
              {preview.errorReport.length > 0 && <Button variant="outline" onClick={() => downloadErrors(preview.errorReport, 'import-errors.csv')}><Download className="ms-1 h-4 w-4" />دانلود گزارش خطا</Button>}
              <Button onClick={reset}>واردسازی جدید</Button>
            </div>
          </div>
        </Section>
      )}

      <Section title="سوابق واردسازی" className="mt-8">
        {!history.data?.batches.length ? <p className="text-sm text-muted-foreground">سابقه‌ای ثبت نشده است.</p> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="text-right">فایل</TableHead><TableHead className="text-right">زمان</TableHead><TableHead className="hidden text-right sm:table-cell">کاربر</TableHead><TableHead className="text-right">ردیف / خطا</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {history.data.batches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="max-w-[180px] truncate">{b.fileName}</TableCell><TableCell className="text-xs">{faDateTime(b.createdAt)}</TableCell><TableCell className="hidden sm:table-cell">{b.uploadedBy}</TableCell>
                    <TableCell className="num">{faNum(b.totalRows)} / {faNum(b.errorRows)}</TableCell>
                    <TableCell><Pill tone={b.status === 'Committed' ? 'success' : b.status === 'Failed' ? 'danger' : b.status === 'Preview' ? 'info' : 'muted'}>{({ Committed: 'ثبت‌شده', Preview: 'پیش‌نمایش', Cancelled: 'لغوشده', Failed: 'ناموفق' } as Record<string, string>)[b.status] ?? b.status}</Pill></TableCell>
                    <TableCell>{b.errorRows > 0 && <Button size="sm" variant="ghost" onClick={() => downloadErrors(JSON.parse(b.errorReport || '[]'), `errors-${b.id.slice(0, 8)}.csv`)}><Download className="h-4 w-4" /></Button>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأیید نهایی واردسازی</AlertDialogTitle>
            <AlertDialogDescription>{preview && `${faNum(preview.summary.new)} دانشجوی جدید اضافه، ${faNum(preview.summary.changed)} دانشجو به‌روزرسانی، ${faNum(preview.summary.returning)} دانشجوی بازگشتی فعال و ${faNum(preview.summary.removed)} دانشجو از فهرست حذف می‌شود.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2"><AlertDialogCancel>انصراف</AlertDialogCancel><AlertDialogAction onClick={commit}>ثبت نهایی</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
