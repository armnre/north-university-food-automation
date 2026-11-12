import { useRef, useState } from 'react';
import { Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { financeAdjust, financeRefundsDue } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { EmptyState, ErrorState, LoadingBlock, Section } from './ui-kit';
import { errMsg, faDateTime, faDigits, newKey, rial } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { useSession } from '../lib/session';

type Refund = { accountId: string; amountRial: number; studentNumber: string | null; employeeUsername: string | null; owner: string; lastAt: string | null };

/** Money owed back to customers (cancelled reservations, items that failed after payment). Finance pays it out and records it here. */
export default function RefundsDue({ canWrite, onChanged }: { canWrite: boolean; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(async (t) => (await financeRefundsDue({ token: t })) as { refunds: Refund[] });
  const [target, setTarget] = useState<Refund | null>(null);
  const total = data?.refunds.reduce((s, r) => s + r.amountRial, 0) ?? 0;
  return (
    <Section title="استردادهای در انتظار" className="mb-6"
      actions={data?.refunds.length ? <span className="num text-sm font-semibold">{rial(total)}</span> : undefined}>
      <p className="mb-3 text-xs text-muted-foreground">مبالغ رزروهای لغوشده یا اقلامی که پس از پرداخت رزرو نشدند. پس از واریز به کارت/حساب کاربر، «ثبت استرداد» را بزنید.</p>
      {loading ? <LoadingBlock rows={2} /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.refunds.length ? <EmptyState title="استرداد معوقی وجود ندارد" /> : (
        <ul className="divide-y rounded-xl border bg-card">
          {data.refunds.map((r) => (
            <li key={r.accountId} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <div className="font-semibold">{r.owner}</div>
                <div className="text-xs text-muted-foreground"><span className="num">{faDigits(r.studentNumber ?? r.employeeUsername ?? '—')}</span>{r.lastAt && <> · {faDateTime(r.lastAt)}</>}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="num font-bold">{rial(r.amountRial)}</span>
                {canWrite && <Button size="sm" onClick={() => setTarget(r)}><Undo2 className="ms-1 h-4 w-4" />ثبت استرداد</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {target && <PayoutDialog r={target} onClose={() => setTarget(null)} onDone={() => { reload(); onChanged(); }} />}
    </Section>
  );
}

function PayoutDialog({ r, onClose, onDone }: { r: Refund; onClose: () => void; onDone: () => void }) {
  const { token } = useSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const submit = async () => {
    setBusy(true);
    try {
      await financeAdjust({ token, studentNumber: r.studentNumber ?? undefined, employeeUsername: r.studentNumber ? undefined : r.employeeUsername ?? undefined, amountRial: -r.amountRial, kind: 'MANUAL_CASH', reason: `استرداد: ${reason.trim()}`, idempotencyKey: key.current });
      toast.success('استرداد ثبت شد.'); onClose(); onDone();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader><DialogTitle>ثبت استرداد {rial(r.amountRial)}</DialogTitle><DialogDescription>برای {r.owner}. ابتدا مبلغ را واریز کنید، سپس شماره پیگیری واریز را اینجا ثبت کنید.</DialogDescription></DialogHeader>
        <div className="space-y-1.5"><Label>شماره پیگیری واریز / توضیح</Label><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: واریز کارت‌به‌کارت، پیگیری ۱۲۳۴۵۶" /></div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button>
          <Button onClick={submit} disabled={busy || reason.trim().length < 5}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}تأیید و ثبت</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
