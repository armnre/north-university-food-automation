import { useRef, useState } from 'react';
import { useDebounce } from 'use-debounce';
import { AlertTriangle, CheckCircle2, Download, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { financeAdjust, financeLedger } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@project/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Section, StatCard } from '../../components/ui-kit';
import { LEDGER_TYPES, downloadCsv, errMsg, faDateTime, faDigits, faNum, newKey, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type Entry = { id: string; trackingCode: string; type: string; amountRial: number; counterAccount: string; reason: string; createdAt: string; studentNumber: string; studentName: string; actor: string | null; reservationCode: string | null };
type Data = { entries: Entry[]; totals: { type: string; count: number; total: number }[]; mismatches: { code: string; status: string; priceAtBooking: number; net: number }[]; hasMore: boolean };
const ALL = '__all__';

export default function FinancePage() {
  const { token, me } = useSession();
  const canWrite = me?.kind === 'staff' && me.staff.perms.includes('financeWrite');
  const [type, setType] = useState(ALL);
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useLoad(async (t) => (await financeLedger({ token: t, type: type === ALL ? undefined : type, search: dq || undefined, from: from || undefined, to: to || undefined, offset: page * 100 })) as Data, [type, dq, from, to, page]);
  const [open, setOpen] = useState(false);

  const exportCsv = () => data && downloadCsv('ledger.csv', ['شناسه پیگیری', 'زمان', 'نوع', 'مبلغ (ریال)', 'شماره دانشجویی', 'رزرو', 'کاربر مسئول', 'شرح'], data.entries.map((e) => [e.trackingCode, e.createdAt, LEDGER_TYPES[e.type] ?? e.type, e.amountRial, e.studentNumber, e.reservationCode ?? '', e.actor ?? '', e.reason]));
  return (
    <>
      <PageHeader title="امور مالی" subtitle="دفترکل فقط‌افزودنی است؛ هیچ تراکنشی حذف یا ویرایش نمی‌شود. اصلاح فقط با تراکنش جبرانی." actions={<>
        <Button variant="outline" onClick={exportCsv} disabled={!data?.entries.length}><Download className="ms-1 h-4 w-4" />خروجی CSV</Button>
        {canWrite && <Button onClick={() => setOpen(true)}><Plus className="ms-1 h-4 w-4" />شارژ / برداشت دستی</Button>}
      </>} />
      {data && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Object.keys(LEDGER_TYPES).map((k) => { const t = data.totals.find((x) => x.type === k); return <StatCard key={k} label={LEDGER_TYPES[k]} value={rial(Math.abs(t?.total ?? 0))} hint={`${faNum(t?.count ?? 0)} تراکنش`} />; })}
        </div>
      )}
      {data && (
        <div className={cn('mb-6 flex items-start gap-3 rounded-xl border p-4 text-sm', data.mismatches.length ? 'border-destructive/40 bg-destructive/5' : 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)]')}>
          {data.mismatches.length ? <AlertTriangle className="h-5 w-5 text-destructive" /> : <CheckCircle2 className="h-5 w-5 text-[hsl(var(--success))]" />}
          <div>
            <div className="font-semibold">{data.mismatches.length ? `${faNum(data.mismatches.length)} مغایرت بین رزروها و دفترکل یافت شد` : 'تطبیق رزروها با دفترکل: بدون مغایرت'}</div>
            {data.mismatches.length > 0 && <ul className="mt-2 space-y-1">{data.mismatches.map((m) => <li key={m.code} className="num">رزرو <span dir="ltr" className="font-mono">{m.code}</span> · قیمت {rial(m.priceAtBooking)} · خالص دفترکل {rial(m.net)}</li>)}</ul>}
          </div>
        </div>
      )}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select value={type} onValueChange={(v) => { setType(v); setPage(0); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ALL}>همه‌ی انواع</SelectItem>{Object.entries(LEDGER_TYPES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select>
        <Input placeholder="شماره دانشجویی یا شناسه پیگیری" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <Input type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} aria-label="از تاریخ" />
        <Input type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} aria-label="تا تاریخ" />
      </div>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.entries.length ? <EmptyState title="تراکنشی یافت نشد" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">شناسه</TableHead><TableHead className="text-right">زمان</TableHead><TableHead className="text-right">نوع</TableHead><TableHead className="text-right">دانشجو</TableHead><TableHead className="text-right">مبلغ</TableHead><TableHead className="hidden text-right lg:table-cell">شرح / مسئول</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs" dir="ltr">{e.trackingCode}</TableCell><TableCell className="whitespace-nowrap text-xs">{faDateTime(e.createdAt)}</TableCell>
                  <TableCell>{LEDGER_TYPES[e.type] ?? e.type}{e.reservationCode && <div className="font-mono text-[11px] text-muted-foreground" dir="ltr">{e.reservationCode}</div>}</TableCell>
                  <TableCell><div className="num">{faDigits(e.studentNumber)}</div><div className="text-xs text-muted-foreground">{e.studentName}</div></TableCell>
                  <TableCell className={cn('num whitespace-nowrap font-semibold', e.amountRial >= 0 ? 'text-[hsl(var(--success))]' : 'text-destructive')} dir="ltr">{e.amountRial >= 0 ? '+' : '−'}{rial(Math.abs(e.amountRial))}</TableCell>
                  <TableCell className="hidden max-w-xs text-xs text-muted-foreground lg:table-cell">{e.reason}{e.actor && <div>توسط: {e.actor}</div>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="mt-4 flex justify-center gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>قبلی</Button><Button size="sm" variant="outline" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>بعدی</Button></div>
      {canWrite && <AdjustDialog open={open} onClose={() => setOpen(false)} onDone={reload} token={token} />}
    </>
  );
}

function AdjustDialog({ open, onClose, onDone, token }: { open: boolean; onClose: () => void; onDone: () => void; token: string }) {
  const [f, setF] = useState({ studentNumber: '', direction: 'credit' as 'credit' | 'debit', amount: '', reason: '' });
  const [stage, setStage] = useState<'form' | 'confirm'>('form');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const valid = f.studentNumber.length >= 5 && /^\d+$/.test(f.amount) && Number(f.amount) > 0 && f.reason.trim().length >= 5;
  const close = () => { setF({ studentNumber: '', direction: 'credit', amount: '', reason: '' }); setStage('form'); key.current = newKey(); onClose(); };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await financeAdjust({ token, studentNumber: f.studentNumber, direction: f.direction, amountRial: Number(f.amount), reason: f.reason, idempotencyKey: key.current });
      toast.success(`ثبت شد. شناسه پیگیری ${r.trackingCode} · موجودی جدید ${rial(r.balanceRial)}`); close(); onDone();
    } catch (e) { toast.error(errMsg(e)); setStage('form'); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent dir="rtl">
        <DialogHeader><DialogTitle>عملیات مالی دستی</DialogTitle><DialogDescription>ثبت دلیل الزامی است و نام شما به‌عنوان مسئول در دفترکل و ممیزی ذخیره می‌شود.</DialogDescription></DialogHeader>
        {stage === 'form' ? (
          <div className="grid gap-3">
            <RadioGroup value={f.direction} onValueChange={(v) => setF({ ...f, direction: v as 'credit' })} className="flex gap-6">
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="credit" />شارژ (افزایش)</label>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="debit" />برداشت (کاهش)</label>
            </RadioGroup>
            <div className="space-y-1.5"><Label>شماره دانشجویی</Label><Input dir="ltr" inputMode="numeric" value={f.studentNumber} onChange={(e) => setF({ ...f, studentNumber: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>مبلغ (ریال)</Label><Input dir="ltr" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} />{f.amount && <p className="text-xs text-muted-foreground">{rial(Number(f.amount))}</p>}</div>
            <div className="space-y-1.5"><Label>دلیل و مستند (مثلاً شماره فیش)</Label><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
          </div>
        ) : (
          <div className="rounded-lg border bg-accent p-4 text-sm text-accent-foreground">
            آیا از {f.direction === 'credit' ? 'شارژ' : 'برداشت'} <b className="num">{rial(Number(f.amount))}</b> برای دانشجوی <b className="num">{faDigits(f.studentNumber)}</b> اطمینان دارید؟ این تراکنش قابل حذف نیست.
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={stage === 'form' ? close : () => setStage('form')} disabled={busy}>{stage === 'form' ? 'انصراف' : 'بازگشت'}</Button>
          {stage === 'form' ? <Button onClick={() => setStage('confirm')} disabled={!valid}>ادامه</Button> : <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}تأیید و ثبت</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
