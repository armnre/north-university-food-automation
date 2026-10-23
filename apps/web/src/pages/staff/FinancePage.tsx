import { useRef, useState } from 'react';
import { useDebounce } from 'use-debounce';
import { AlertTriangle, CheckCircle2, Download, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { financeAdjust, financeLedger, financePayments, resolveFinancePayment } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@project/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { cn } from '@project/components/lib/utils';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, StatCard } from '../../components/ui-kit';
import { LEDGER_TYPES, downloadCsv, errMsg, faDateTime, faDigits, faNum, newKey, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type Entry = {
  id: string;
  trackingCode: string;
  type: string;
  amountRial: number;
  systemAccount: string | null;
  reason: string;
  createdAt: string;
  holderIdentifier: string;
  holderName: string;
  customerGroup: string;
  actor: string | null;
  balanceAfter: number | null;
};
type Data = {
  entries: Entry[];
  totals: { type: string; count: number; total: number }[];
  systemAccounts: { account: string; label: string; balanceRial: number }[];
  mismatches: { kind: string; reference: string; expected: number; actual: number }[];
  hasMore: boolean;
};
const ALL = '__all__';

export default function FinancePage() {
  const { me } = useSession();
  const canWrite = me?.kind === 'staff' && me.staff.perms.includes('financeWrite');
  const [type, setType] = useState(ALL);
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useLoad(
    async () =>
      (await financeLedger({
        type: type === ALL ? undefined : type,
        search: dq || undefined,
        from: from || undefined,
        to: to || undefined,
        offset: page * 100,
      })) as unknown as Data,
    [type, dq, from, to, page],
  );
  const [open, setOpen] = useState(false);
  const reviewQueue = useLoad(async () => await financePayments({ status: 'NeedsReview', limit: 50 }), []);
  const [resolveTarget, setResolveTarget] = useState<{ id: string; amountRial: number; holderIdentifier: string; refId: string | null } | null>(null);

  const exportCsv = () =>
    data &&
    downloadCsv(
      'ledger.csv',
      ['شناسه پیگیری', 'زمان', 'نوع', 'مبلغ (ریال)', 'شماره دانشجویی / کاربری', 'نام', 'کاربر مسئول', 'شرح'],
      data.entries.map((e) => [
        e.trackingCode,
        e.createdAt,
        LEDGER_TYPES[e.type] ?? e.type,
        e.amountRial,
        e.holderIdentifier,
        e.holderName,
        e.actor ?? '',
        e.reason,
      ]),
    );
  return (
    <>
      <PageHeader
        title="امور مالی"
        subtitle="دفتر کل فقط‌افزودنی است؛ هیچ تراکنشی حذف یا ویرایش نمی‌شود. اصلاح فقط با تراکنش جبرانی انجام می‌شود."
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={!data?.entries.length}>
              <Download className="ms-1 h-4 w-4" />
              خروجی CSV
            </Button>
            {canWrite && (
              <Button onClick={() => setOpen(true)}>
                <Plus className="ms-1 h-4 w-4" />
                اصلاح دستی اعتبار
              </Button>
            )}
          </>
        }
      />
      {data && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {['OnlinePayment', 'ReservationDebit', 'CancellationRefund', 'MealUnavailableRefund', 'AdminRefund', 'ManualCredit', 'ManualDebit', 'Correction'].map((k) => {
            const t = data.totals.find((x) => x.type === k);
            return <StatCard key={k} label={LEDGER_TYPES[k] ?? k} value={rial(Math.abs(t?.total ?? 0))} hint={`${faNum(t?.count ?? 0)} تراکنش`} />;
          })}
        </div>
      )}
      {data && (
        <div
          className={cn(
            'mb-6 flex items-start gap-3 rounded-xl border p-4 text-sm',
            data.mismatches.length ? 'border-destructive/40 bg-destructive/5' : 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)]',
          )}
        >
          {data.mismatches.length ? (
            <AlertTriangle className="h-5 w-5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-[hsl(var(--success))]" />
          )}
          <div>
            <div className="font-semibold">
              {data.mismatches.length
                ? `${faNum(data.mismatches.length)} مغایرت در تطبیق دفتر کل یافت شد`
                : 'تطبیق حساب‌ها و تراکنش‌های دفتر کل: بدون مغایرت'}
            </div>
            {data.mismatches.length > 0 && (
              <ul className="mt-2 space-y-1">
                {data.mismatches.map((m) => (
                  <li key={`${m.kind}:${m.reference}`} className="num">
                    <span dir="ltr" className="font-mono">
                      {m.reference}
                    </span>{' '}
                    · مورد انتظار {rial(m.expected)} · ثبت‌شده {rial(m.actual)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {reviewQueue.data && reviewQueue.data.needsReviewCount > 0 && (
        <div className="mb-6 rounded-xl border border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.08)] p-4">
          <div className="mb-3 flex items-center gap-2 font-bold text-[hsl(var(--warning))]">
            <AlertTriangle className="h-5 w-5" />
            <span>{faNum(reviewQueue.data.needsReviewCount)} پرداخت درگاه نیازمند بررسی فوری (NeedsReview)</span>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">دانشجو / کاربر</TableHead>
                  <TableHead className="text-right">مبلغ درگاه</TableHead>
                  <TableHead className="text-right">کد مرجع / خطا</TableHead>
                  <TableHead className="text-right">زمان</TableHead>
                  {canWrite && <TableHead className="text-left">تعیین تکلیف</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewQueue.data.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="num font-semibold">{faDigits(p.holderIdentifier)}</div>
                      <div className="text-xs text-muted-foreground">{p.holderName}</div>
                    </TableCell>
                    <TableCell className="num font-semibold">{rial(p.amountRial)}</TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      <div>{p.refId || p.authority || '—'}</div>
                      {p.lastError && <div className="text-[11px] text-destructive">{p.lastError}</div>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{faDateTime(p.createdAt)}</TableCell>
                    {canWrite && (
                      <TableCell className="text-left">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setResolveTarget({
                              id: p.id,
                              amountRial: p.amountRial,
                              holderIdentifier: p.holderIdentifier,
                              refId: p.refId,
                            })
                          }
                        >
                          رسیدگی
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v);
            setPage(0);
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>همه‌ی انواع</SelectItem>
            {Object.entries(LEDGER_TYPES).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="شماره دانشجویی یا شناسه پیگیری"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
        />
        <Input
          type="date"
          dir="ltr"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setPage(0);
          }}
          aria-label="از تاریخ"
        />
        <Input
          type="date"
          dir="ltr"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setPage(0);
          }}
          aria-label="تا تاریخ"
        />
      </div>
      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data?.entries.length ? (
        <EmptyState title="تراکنشی یافت نشد" />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">شناسه</TableHead>
                <TableHead className="text-right">زمان</TableHead>
                <TableHead className="text-right">نوع</TableHead>
                <TableHead className="text-right">دانشجو / کاربر</TableHead>
                <TableHead className="text-right">مبلغ</TableHead>
                <TableHead className="hidden text-right lg:table-cell">شرح / مسئول</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs" dir="ltr">
                    {e.trackingCode}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{faDateTime(e.createdAt)}</TableCell>
                  <TableCell>{LEDGER_TYPES[e.type] ?? e.type}</TableCell>
                  <TableCell>
                    <div className="num">{faDigits(e.holderIdentifier)}</div>
                    <div className="text-xs text-muted-foreground">{e.holderName}</div>
                  </TableCell>
                  <TableCell
                    className={cn('num whitespace-nowrap font-semibold', e.amountRial >= 0 ? 'text-[hsl(var(--success))]' : 'text-destructive')}
                    dir="ltr"
                  >
                    {e.amountRial >= 0 ? '+' : '−'}
                    {rial(Math.abs(e.amountRial))}
                  </TableCell>
                  <TableCell className="hidden max-w-xs text-xs text-muted-foreground lg:table-cell">
                    {e.reason}
                    {e.actor && <div>توسط: {e.actor}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="mt-4 flex justify-center gap-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
          قبلی
        </Button>
        <Button size="sm" variant="outline" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>
          بعدی
        </Button>
      </div>
      {canWrite && <AdjustDialog open={open} onClose={() => setOpen(false)} onDone={reload} />}
      {canWrite && (
        <ResolvePaymentDialog
          target={resolveTarget}
          onClose={() => setResolveTarget(null)}
          onDone={() => {
            setResolveTarget(null);
            reviewQueue.reload();
            reload();
          }}
        />
      )}
    </>
  );
}

function ResolvePaymentDialog({
  target,
  onClose,
  onDone,
}: {
  target: { id: string; amountRial: number; holderIdentifier: string; refId: string | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<'retry_settle' | 'mark_failed'>('retry_settle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await resolveFinancePayment(target.id, { action, reason: reason.trim() });
      toast.success(`وضعیت پرداخت به ${r.status} تغییر یافت.`);
      setReason('');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>رسیدگی به پرداخت نیازمند بررسی</DialogTitle>
          <DialogDescription>
            حساب <span className="num font-semibold">{faDigits(target?.holderIdentifier ?? '')}</span> · مبلغ{' '}
            <span className="num font-semibold">{rial(target?.amountRial ?? 0)}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <RadioGroup value={action} onValueChange={(v) => setAction(v as 'retry_settle' | 'mark_failed')} className="grid gap-2">
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="retry_settle" />
              تأیید و تکمیل ثبت رزرو / انتقال به اعتبار کیف پول
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="mark_failed" />
              ثبت به‌عنوان پرداخت ناموفق (فقط پس از اطمینان از عدم کسر وجه در پنل زرین‌پال)
            </label>
          </RadioGroup>
          <div className="space-y-1.5">
            <Label>شرح بررسی و مستند بانکی (حداقل ۵ کاراکتر)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button onClick={submit} disabled={busy || reason.trim().length < 5}>
            {busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}
            ثبت نتیجهٔ بررسی
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ subject: 'student' as 'student' | 'employee', identifier: '', direction: 'credit' as 'credit' | 'debit', amount: '', reason: '' });
  const [stage, setStage] = useState<'form' | 'confirm'>('form');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const valid = f.identifier.trim().length >= 3 && /^\d+$/.test(f.amount) && Number(f.amount) > 0 && f.reason.trim().length >= 5;
  const close = () => {
    setF({ subject: 'student', identifier: '', direction: 'credit', amount: '', reason: '' });
    setStage('form');
    key.current = newKey();
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await financeAdjust({
        subject: f.subject,
        identifier: f.identifier.trim(),
        direction: f.direction,
        amountRial: Number(f.amount),
        reason: f.reason.trim(),
        idempotencyKey: key.current,
      });
      toast.success(`ثبت شد. شناسه پیگیری ${r.trackingCode} · موجودی جدید ${rial(r.balanceRial)}`);
      close();
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
      setStage('form');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>اصلاح دستی اعتبار (امور مالی)</DialogTitle>
          <DialogDescription>ثبت دلیل الزامی است و نام شما به‌عنوان مسئول در دفتر کل و لاگ ممیزی ذخیره می‌شود.</DialogDescription>
        </DialogHeader>
        {stage === 'form' ? (
          <div className="grid gap-3">
            <RadioGroup value={f.direction} onValueChange={(v) => setF({ ...f, direction: v as 'credit' })} className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="credit" />
                افزایش اعتبار (بستانکار)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="debit" />
                کاهش اعتبار (بدهکار)
              </label>
            </RadioGroup>
            <div className="space-y-1.5">
              <Label>شماره دانشجویی</Label>
              <Input dir="ltr" inputMode="numeric" value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>مبلغ (ریال)</Label>
              <Input dir="ltr" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, '') })} />
              {f.amount && <p className="text-xs text-muted-foreground">{rial(Number(f.amount))}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>دلیل و مستند (الزامی، حداقل ۵ کاراکتر)</Label>
              <Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </div>
          </div>
        ) : (
          <div className="rounded-lg border bg-accent p-4 text-sm text-accent-foreground">
            آیا از {f.direction === 'credit' ? 'افزایش اعتبار' : 'کاهش اعتبار'} به مبلغ <b className="num">{rial(Number(f.amount))}</b> برای حساب{' '}
            <b className="num">{faDigits(f.identifier)}</b> اطمینان دارید؟ این تراکنش قابل حذف نیست.
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={stage === 'form' ? close : () => setStage('form')} disabled={busy}>
            {stage === 'form' ? 'انصراف' : 'بازگشت'}
          </Button>
          {stage === 'form' ? (
            <Button onClick={() => setStage('confirm')} disabled={!valid}>
              ادامه
            </Button>
          ) : (
            <Button onClick={submit} disabled={busy}>
              {busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}
              تأیید و ثبت
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
