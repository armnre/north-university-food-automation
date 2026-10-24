import { useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, FileUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { employeesBulk } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { errMsg, faNum } from '../lib/format';

type Row = { username: string; firstName: string; lastName: string; kind: string; personnelCode?: string; mobile?: string };
const MAX = 300;
const KIND_MAP: Record<string, string> = { staff: 'Staff', faculty: 'Faculty', contractor: 'Contractor', 'کارمند': 'Staff', 'هیئت علمی': 'Faculty', 'پیمانکار': 'Contractor' };
const COLS: Record<string, keyof Row> = { username: 'username', 'نام کاربری': 'username', first_name: 'firstName', firstname: 'firstName', 'نام': 'firstName', last_name: 'lastName', lastname: 'lastName', 'نام خانوادگی': 'lastName', kind: 'kind', 'نوع': 'kind', personnel_code: 'personnelCode', 'کد پرسنلی': 'personnelCode', mobile: 'mobile', 'موبایل': 'mobile' };
const fa2en = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

function parse(rows: string[][]): { rows: Row[]; errors: string[] } {
  const head = (rows[0] ?? []).map((h) => COLS[h.trim().toLowerCase()] ?? COLS[h.trim()]);
  const errors: string[] = [];
  if (!head.includes('username') || !head.includes('firstName') || !head.includes('lastName')) return { rows: [], errors: ['ستون‌های username، first_name و last_name الزامی است.'] };
  const out: Row[] = [];
  rows.slice(1).forEach((r, i) => {
    const o: Record<string, string> = {};
    head.forEach((k, j) => { if (k && r[j]) o[k] = fa2en(r[j].trim()); });
    const line = i + 2;
    if (!/^[a-zA-Z0-9._-]{3,50}$/.test(o.username ?? '')) errors.push(`ردیف ${faNum(line)}: نام کاربری نامعتبر`);
    else if (!o.firstName || !o.lastName) errors.push(`ردیف ${faNum(line)}: نام و نام خانوادگی الزامی است`);
    else out.push({ username: o.username, firstName: o.firstName, lastName: o.lastName, kind: KIND_MAP[(o.kind ?? '').toLowerCase()] ?? KIND_MAP[o.kind ?? ''] ?? 'Staff', personnelCode: o.personnelCode || undefined, mobile: o.mobile || undefined });
  });
  const seen = new Set<string>();
  for (const r of out) { const u = r.username.toLowerCase(); if (seen.has(u)) errors.push(`نام کاربری تکراری: ${r.username}`); seen.add(u); }
  if (out.length > MAX) errors.push(`حداکثر ${faNum(MAX)} ردیف مجاز است.`);
  return { rows: out, errors };
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export default function EmployeeBulkDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [parsed, setParsed] = useState<{ rows: Row[]; errors: string[]; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<{ created: number; csv: string } | null>(null);

  const onFile = async (f?: File) => {
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast.error('فقط فایل xlsx یا csv مجاز است.');
    if (f.size > 2 * 1024 * 1024) return toast.error('حداکثر حجم فایل ۲ مگابایت است.');
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '', blankrows: false }).map((r) => r.map((c) => String(c ?? '')));
      setParsed({ ...parse(rows), name: f.name });
    } catch { toast.error('خواندن فایل ممکن نشد.'); }
  };

  const submit = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const r = (await employeesBulk({ rows: parsed.rows })) as { created: number; credentialsCsv: string };
      setCreds({ created: r.created, csv: r.credentialsCsv });
      onSaved();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const ok = parsed && parsed.rows.length > 0 && parsed.errors.length === 0;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>افزودن گروهی کارمندان</DialogTitle>
          <DialogDescription>فایل با ستون‌های username، first_name، last_name و (اختیاری) kind، personnel_code، mobile. همه ردیف‌ها با هم ثبت می‌شوند یا هیچ‌کدام.</DialogDescription>
        </DialogHeader>
        {creds ? (
          <div className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
            <p className="font-medium">{faNum(creds.created)} کارمند ثبت شد.</p>
            <p className="text-muted-foreground">رمزهای موقت فقط همین یک‌بار نمایش داده می‌شوند و جایی ذخیره نمی‌شوند. فایل را دانلود و به‌صورت امن تحویل دهید.</p>
            <Button onClick={() => download('employee-credentials.csv', creds.csv)}><Download className="ms-1 h-4 w-4" />دانلود رمزهای موقت</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Button variant="link" className="h-auto p-0 text-xs" onClick={() => download('employees-template.csv', '\ufeffusername,first_name,last_name,kind,personnel_code,mobile\nali.rezaei,علی,رضایی,Staff,12345,09120000000\n')}>دانلود فایل نمونه</Button>
            <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed p-6 text-center hover:bg-muted/40">
              <FileUp className="mb-2 h-6 w-6 text-muted-foreground" />
              <span className="text-sm font-medium">{parsed?.name ?? 'انتخاب فایل xlsx یا csv'}</span>
              <span className="mt-1 text-xs text-muted-foreground">حداکثر {faNum(MAX)} ردیف · ردیف اول عنوان ستون‌ها</span>
              <input type="file" className="sr-only" accept=".xlsx,.csv" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {parsed && (
              <div className="text-sm">
                <p>{faNum(parsed.rows.length)} ردیف معتبر</p>
                {parsed.errors.length > 0 && (
                  <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto pe-5 text-destructive">
                    {parsed.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {creds ? <Button variant="outline" onClick={onClose}>بستن</Button> : (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button>
              <Button onClick={submit} disabled={!ok || busy}>{busy && <Loader2 className="ms-1 h-4 w-4 animate-spin" />}ثبت {ok ? faNum(parsed.rows.length) : ''} کارمند</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
