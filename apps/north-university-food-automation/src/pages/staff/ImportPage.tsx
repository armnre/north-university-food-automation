import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { importCancel, importCommit, importList, importPreview, importUndo } from '../../lib/api';
import ConfirmButton from '../../components/ConfirmButton';
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
import { useSession } from '../../lib/session';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 3000;
const FIELDS = [
  { key: 'studentNumber', label: 'شماره دانشجویی', req: true, guess: ['شماره دانشجویی', 'شماره دانشجو', 'student', 'stno'] },
  { key: 'nationalId', label: 'کد ملی', req: true, guess: ['کد ملی', 'کدملی', 'شماره ملی', 'national'] },
  { key: 'fullName', label: 'نام کامل', req: false, guess: ['نام و نام خانوادگی', 'نام کامل', 'fullname'] },
  { key: 'firstName', label: 'نام', req: false, guess: ['نام', 'first'] },
  { key: 'lastName', label: 'نام خانوادگی', req: false, guess: ['نام خانوادگی', 'فامیلی', 'last'] },
  { key: 'faculty', label: 'دانشکده', req: false, guess: ['دانشکده', 'faculty'] },
  { key: 'major', label: 'رشته', req: false, guess: ['رشته', 'رشته تحصیلی', 'major'] },
  { key: 'degree', label: 'مقطع', req: false, guess: ['مقطع', 'degree'] },
  { key: 'entryYear', label: 'سال ورود', req: false, guess: ['سال ورود', 'ورودی', 'entry'] },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];
type Preview = {
  batchId: string; summary: { total: number; valid: number; errors: number; new: number; changed: number; unchanged: number; returning: number; removed: number }; duplicateOfCommitted: boolean; blocked: boolean;
  removed: { id: string; studentNumber: string; fullName: string; faculty: string; major: string; status: string }[]; massRemovalWarning: boolean;
  rows: { rowNumber: number; studentNumber: string; fullName: string; faculty: string; major: string; kind: string; errors: string[]; changes: string[] }[];
  errorReport: { rowNumber: number; studentNumber: string; errors: string[] }[];
};
const NONE = '__none__';
const KIND: Record<string, string> = { error: 'خطا', new: 'جدید', changed: 'تغییر', unchanged: 'بدون تغییر', returning: 'بازگشتی' };
const STEPS = ['انتخاب فایل', 'تطبیق ستون‌ها', 'پیش‌نمایش و بررسی', 'گزارش نهایی'];

function guessMapping(headers: string[]) {
  const m: Partial<Record<FieldKey, string>> = {};
  for (const f of FIELDS) {
    const exact = headers.find((h) => f.guess.some((g) => h.trim().toLowerCase() === g.toLowerCase()));
    const loose = headers.find((h) => f.guess.some((g) => h.toLowerCase().includes(g.toLowerCase())) && !Object.values(m).includes(h));
    if (exact ?? loose) m[f.key] = exact ?? loose;
  }
  if (m.firstName && m.firstName === m.lastName) delete m.firstName;
  return m;
}

export default function ImportPage() {
  const { token } = useSession();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [raw, setRaw] = useState<string[][]>([]);
  const [map, setMap] = useState<Partial<Record<FieldKey, string>>>({});
  const [policy, setPolicy] = useState<'RejectAllOnError' | 'SkipInvalidRows'>('RejectAllOnError');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fullSync, setFullSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{ written: number; removed?: number } | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'new' | 'changed' | 'returning' | 'removed'>('all');
  const history = useLoad(async (t) => (await importList({ token: t })) as { batches: { id: string; fileName: string; status: string; totalRows: number; validRows: number; errorRows: number; newRows: number; changedRows: number; errorReport: string; createdAt: string; uploadedBy: string }[] });

  const reset = () => { setStep(0); setFile(null); setHeaders([]); setRaw([]); setMap({}); setPreview(null); setResult(null); };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(xlsx|xls|csv)$/i.test(f.name)) return toast.error('فقط فایل‌های Excel (xlsx، xls) یا CSV مجاز است.');
    if (f.size > MAX_BYTES) return toast.error('حجم فایل بیش از ۵ مگابایت است.');
    try {
      // values only: formulas, HTML and styles are ignored
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: false }).map((r) => r.map((c) => String(c ?? '').trim()));
      if (rows.length < 2) return toast.error('فایل خالی است یا ردیف داده ندارد.');
      if (rows.length - 1 > MAX_ROWS) return toast.error(`حداکثر ${faNum(MAX_ROWS)} ردیف در هر فایل مجاز است.`);
      const hs = rows[0].map((h, i) => h || `ستون ${i + 1}`);
      setFile(f); setHeaders(hs); setRaw(rows.slice(1)); setMap(guessMapping(hs)); setStep(1);
    } catch { toast.error('ساختار فایل قابل خواندن نیست.'); }
  };

  const mappingOk = !!map.studentNumber && !!map.nationalId && (!!map.fullName || !!map.firstName || !!map.lastName);
  const buildRows = () => {
    const idx = (k: FieldKey) => (map[k] ? headers.indexOf(map[k]!) : -1);
    const get = (r: string[], k: FieldKey) => (idx(k) >= 0 ? r[idx(k)] ?? '' : '');
    return raw.map((r, i) => ({
      rowNumber: i + 2, studentNumber: get(r, 'studentNumber'), nationalId: get(r, 'nationalId'),
      fullName: get(r, 'fullName') || `${get(r, 'firstName')} ${get(r, 'lastName')}`.trim(),
      faculty: get(r, 'faculty'), major: get(r, 'major'), degree: get(r, 'degree'), entryYear: get(r, 'entryYear'),
    }));
  };

  const runPreview = async () => {
    setBusy(true);
    try { setPreview((await importPreview({ file: file!, policy, fullSync, mapping: Object.fromEntries(Object.entries(map).filter(([, v]) => !!v)) as Record<string, string> })) as Preview); setStep(2); history.reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const commit = async () => {
    setConfirmOpen(false); setBusy(true);
    try { const r = await importCommit({ token, batchId: preview!.batchId }); setResult(r); setStep(3); toast.success('واردسازی با موفقیت انجام شد.'); history.reload(); }
    catch (e) { toast.error(errMsg(e)); history.reload(); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (preview) await importCancel({ token, batchId: preview.batchId }).catch(() => undefined);
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
            <span className="mt-1 text-sm text-muted-foreground">فقط xlsx · حداکثر ۵ مگابایت · حداکثر {faNum(MAX_ROWS)} ردیف · ردیف اول باید عنوان ستون‌ها باشد</span>
            <input type="file" className="sr-only" accept=".xlsx" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <p className="mt-4 text-xs text-muted-foreground">ستون‌های الزامی: شماره دانشجویی، کد ملی و نام (یا نام و نام خانوادگی جداگانه). ستون‌های اختیاری: دانشکده، رشته، مقطع، سال ورود.</p>
        </Section>
      )}

      {step === 1 && file && (
        <Section title="تطبیق ستون‌های فایل با فیلدهای سامانه" actions={<span className="text-sm text-muted-foreground"><FileSpreadsheet className="ms-1 inline h-4 w-4" />{file.name} · {faNum(Math.round(file.size / 1024))} KB · {faNum(raw.length)} ردیف</span>}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label>{f.label}{f.req && <span className="text-destructive"> *</span>}</Label>
                <Select value={map[f.key] ?? NONE} onValueChange={(v) => setMap({ ...map, [f.key]: v === NONE ? undefined : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={NONE}>— انتخاب نشده —</SelectItem>{headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="mt-6 space-y-2">
            <Label>سیاست رکوردهای خطادار</Label>
            <RadioGroup value={policy} onValueChange={(v) => setPolicy(v as typeof policy)} className="gap-2">
              <label className="flex items-start gap-2 text-sm"><RadioGroupItem value="RejectAllOnError" className="mt-1" /><span><b>رد کامل در صورت هر خطا</b> — اگر حتی یک ردیف خطا داشته باشد، هیچ اطلاعاتی ثبت نمی‌شود (پیشنهادی).</span></label>
              <label className="flex items-start gap-2 text-sm"><RadioGroupItem value="SkipInvalidRows" className="mt-1" /><span><b>ثبت ردیف‌های معتبر</b> — ردیف‌های خطادار کنار گذاشته و در گزارش خطا ذکر می‌شوند.</span></label>
            </RadioGroup>
          </div>
          <label className="mt-6 flex items-start gap-3 rounded-lg border bg-secondary/40 p-3 text-sm">
            <Switch checked={fullSync} onCheckedChange={setFullSync} className="mt-0.5" />
            <span><b>مغایرت‌گیری کامل با فهرست فعلی</b> — این فایل فهرست کامل و به‌روز دانشجویان است. دانشجویانی که در سامانه هستند ولی در این فایل نیستند «حذف‌شده از فهرست» می‌شوند (سوابق مالی و رزروشان حفظ می‌شود ولی دیگر نمی‌توانند وارد شوند). اگر فایل فقط شامل دانشجویان جدید است، این گزینه را خاموش کنید.</span>
          </label>
          <div className="mt-6 flex justify-between gap-2">
            <Button variant="outline" onClick={reset}>انتخاب فایل دیگر</Button>
            <Button onClick={runPreview} disabled={!mappingOk || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}بررسی و پیش‌نمایش</Button>
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
                    <TableCell><Pill tone={b.status === 'Committed' ? 'success' : b.status === 'Failed' ? 'danger' : b.status === 'Preview' ? 'info' : 'muted'}>{({ Committed: 'ثبت‌شده', Preview: 'پیش‌نمایش', Cancelled: 'لغوشده', Failed: 'ناموفق', Undone: 'بازگردانی‌شده' } as Record<string, string>)[b.status] ?? b.status}</Pill></TableCell>
                    <TableCell>{b.errorRows > 0 && <Button size="sm" variant="ghost" onClick={() => downloadErrors(JSON.parse(b.errorReport || '[]'), `errors-${b.id.slice(0, 8)}.csv`)}><Download className="h-4 w-4" /></Button>}
                      {b.id === history.data!.batches.find((x) => x.status === 'Committed')?.id && (
                        <ConfirmButton size="sm" variant="ghost" className="text-destructive" title="بازگردانی آخرین واردسازی" confirmLabel="بازگردانی"
                          description="دانشجویانی که با این فایل اضافه شده‌اند و هنوز وارد نشده‌اند و رزرو یا تراکنشی ندارند حذف می‌شوند. فقط آخرین دسته‌ی ثبت‌شده قابل بازگردانی است."
                          action={async () => { const r = await importUndo({ batchId: b.id }); history.reload(); return faNum(r.removed) + ' ردیف بازگردانی شد.'; }}>بازگردانی</ConfirmButton>
                      )}</TableCell>
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
