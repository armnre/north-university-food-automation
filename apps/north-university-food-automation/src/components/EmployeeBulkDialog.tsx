import { useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, FileUp, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { employeesBulk } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { errMsg, faNum } from '../lib/format';

type Row = { username: string; firstName: string; lastName: string; kind: string; personnelCode?: string; mobile?: string; nationalId?: string };
const MAX = 1000;
const KIND_MAP: Record<string, string> = { staff: 'Staff', faculty: 'Faculty', contractor: 'Contractor', 'کارمند': 'Staff', 'هیئت علمی': 'Faculty', visiting: 'Visiting', 'مدعو': 'Visiting', 'استاد مدعو': 'Visiting', 'استاد': 'Faculty', 'پیمانکار': 'Contractor' };
const COLS: Record<string, keyof Row> = {
  username: 'username', 'نام کاربری': 'username', 'شماره پرسنلی': 'username', 'شماره کارگزینی': 'username', 'کد پرسنلی': 'username',
  first_name: 'firstName', firstname: 'firstName', 'نام': 'firstName',
  last_name: 'lastName', lastname: 'lastName', 'نام خانوادگی': 'lastName', 'نامخانوادگی': 'lastName',
  kind: 'kind', 'نوع': 'kind', personnel_code: 'personnelCode', mobile: 'mobile', 'موبایل': 'mobile',
  national_id: 'nationalId', 'کد ملی': 'nationalId', 'شماره ملی': 'nationalId',
};
/** Unifies Arabic ي/ك, ZWNJ and spacing so headers like «نام‌خانوادگي» or «شماره كارگزيني» match. */
const normHead = (h: string) => h.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const colOf = (h: string) => COLS[normHead(h)] ?? COLS[normHead(h).replace(/ /g, '')];
const fa2en = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

function parse(rows: string[][], defKind: string): { rows: Row[]; errors: string[] } {
  const hi = rows.findIndex((r) => r.some((c) => colOf(c) === 'username'));
  if (hi > 0) rows = rows.slice(hi);
  const head = (rows[0] ?? []).map((h) => colOf(h));
  const errors: string[] = [];
  if (!head.includes('username') || !head.includes('firstName') || !head.includes('lastName')) return { rows: [], errors: ['ستون‌های «شماره پرسنلی/کارگزینی»، «نام» و «نام خانوادگی» الزامی است.'] };
  const out: Row[] = [];
  rows.slice(1).forEach((r, i) => {
    const o: Record<string, string> = {};
    head.forEach((k, j) => { if (k && r[j]) o[k] = fa2en(r[j].trim()); });
    const line = i + 2;
    if (!/^[a-zA-Z0-9._-]{3,50}$/.test(o.username ?? '')) errors.push(`ردیف ${faNum(line)}: نام کاربری نامعتبر`);
    else if (!o.firstName || !o.lastName) errors.push(`ردیف ${faNum(line)}: نام و نام خانوادگی الزامی است`);
    else if (o.nationalId && o.nationalId.replace(/\D/g, '').length > 10) errors.push(`ردیف ${faNum(line)}: کد ملی نامعتبر`);
    else out.push({ username: o.username, firstName: o.firstName, lastName: o.lastName, kind: KIND_MAP[(o.kind ?? '').toLowerCase()] ?? KIND_MAP[o.kind ?? ''] ?? defKind, personnelCode: o.personnelCode || o.username, mobile: o.mobile || undefined, nationalId: o.nationalId ? o.nationalId.replace(/\D/g, '').padStart(10, '0') : undefined });
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
  const [kind, setKind] = useState<'Staff' | 'Faculty'>('Staff');
  const [sheet, setSheet] = useState<string[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<{ created: number; updated: number; csv: string } | null>(null);

  const onFile = async (f?: File) => {
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast.error('فقط فایل xlsx یا csv مجاز است.');
    if (f.size > 2 * 1024 * 1024) return toast.error('حداکثر حجم فایل ۲ مگابایت است.');
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false });
      // Pick the first sheet that has a personnel/kargozini column (the files also carry print templates).
      let rows: string[][] = [];
      for (const n of wb.SheetNames) {
        const r = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: '', blankrows: false }).map((x) => x.map((c) => String(c ?? '')));
        if (r.slice(0, 10).some((x) => x.some((c) => colOf(c) === 'username'))) { rows = r; break; }
        if (!rows.length) rows = r;
      }
      if (rows.some((x) => x.some((c) => /کارگزینی|كارگزيني/.test(c)))) setKind('Faculty');
      else if (rows.some((x) => x.some((c) => /پرسنلی/.test(c)))) setKind('Staff');
      const k = rows.some((x) => x.some((c) => /کارگزینی|كارگزيني/.test(c))) ? 'Faculty' : rows.some((x) => x.some((c) => /پرسنلی/.test(c))) ? 'Staff' : kind;
      setSheet(rows);
      setParsed({ ...parse(rows, k), name: f.name });
    } catch { toast.error('خواندن فایل ممکن نشد.'); }
  };

  const submit = async () => {
    if (!parsed) return;
    setBusy(true);
    try {
      const r = (await employeesBulk({ rows: parsed.rows, upsert: true })) as { created: number; updated?: number; credentialsCsv: string };
      setCreds({ created: r.created, updated: r.updated ?? 0, csv: r.credentialsCsv });
      onSaved();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const ok = parsed && parsed.rows.length > 0 && parsed.errors.length === 0;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>ورود گروهی کارکنان / اساتید از اکسل</DialogTitle>
          <DialogDescription>فایل اکسل کارکنان (شماره پرسنلی، نام، نام خانوادگی، شماره ملی) یا هیئت علمی (شماره کارگزینی، نام، نام خانوادگی، کد ملی). نام کاربری = شماره پرسنلی/کارگزینی و رمز عبور = کد ملی. افراد موجود به‌روزرسانی می‌شوند.</DialogDescription>
        </DialogHeader>
        {creds ? (
          <div className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
            <p className="font-medium">{faNum(creds.created)} نفر ثبت و {faNum(creds.updated)} نفر به‌روزرسانی شد.</p>
            <p className="text-muted-foreground">افرادی که کد ملی دارند با شماره پرسنلی/کارگزینی و کد ملی وارد می‌شوند.</p>
            {creds.csv && <><p className="text-muted-foreground">برای ردیف‌های بدون کد ملی رمز موقت ساخته شد؛ فقط همین یک‌بار نمایش داده می‌شود.</p>
            <Button onClick={() => download('employee-credentials.csv', creds.csv)}><Download className="ms-1 h-4 w-4" />دانلود رمزهای موقت</Button></>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {(['Staff', 'Faculty'] as const).map((k) => (
                <button key={k} type="button" onClick={() => { setKind(k); if (sheet && parsed) setParsed({ ...parse(sheet, k), name: parsed.name }); }} className={`rounded-md py-1.5 text-sm transition ${kind === k ? 'bg-card font-semibold shadow-sm' : 'text-muted-foreground'}`}>{k === 'Staff' ? 'کارکنان' : 'هیئت علمی'}</button>
              ))}
            </div>
            <Button variant="link" className="h-auto p-0 text-xs" onClick={() => download('employees-template.csv', '\ufeffشماره پرسنلی,نام,نام خانوادگی,شماره ملی\n103,علی,رضایی,0012345678\n')}>دانلود فایل نمونه</Button>
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
              <Button onClick={submit} disabled={!ok || busy}>{busy && <Loader2 className="ms-1 h-4 w-4 animate-spin" />}ثبت {ok ? faNum(parsed.rows.length) : ''} نفر</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
