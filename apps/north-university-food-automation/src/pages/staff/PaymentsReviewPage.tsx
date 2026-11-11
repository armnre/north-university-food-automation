import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { paymentResolve, paymentsNeedsReview, paymentsReconcile } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Textarea } from '@project/components/ui/textarea';
import { Label } from '@project/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '../../components/ui-kit';
import { errMsg, faDateTime, faDigits, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

type Payment = { id: string; amountRial: number; refId: string | null; authority: string | null; note: string; owner: string; createdAt: string };
type Action = 'credit' | 'mark-failed';

export default function PaymentsReviewPage() {
  const { data, error, loading, reload } = useLoad(async () => (await paymentsNeedsReview()) as { payments: Payment[] }, []);
  const [target, setTarget] = useState<{ p: Payment; action: Action } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const reconcile = async () => {
    setSyncing(true);
    try {
      const r = await paymentsReconcile();
      toast.success(`${r.checked} پرداخت معلق با درگاه استعلام شد.`);
      reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setSyncing(false); }
  };
  return (
    <>
      <PageHeader title="پرداخت‌های نیازمند بررسی" subtitle="پرداخت‌هایی که درگاه تأیید کرده ولی ثبت خودکار آن‌ها کامل نشده است. پیش از تصمیم، رسید را در پنل زرین‌پال با کد پیگیری بررسی کنید."
        actions={<Button variant="outline" onClick={reconcile} disabled={syncing}>{syncing ? <Loader2 className="ms-1 h-4 w-4 animate-spin" /> : <RefreshCw className="ms-1 h-4 w-4" />}استعلام پرداخت‌های معلق</Button>} />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.payments.length ? <EmptyState title="موردی برای بررسی نیست" text="همه‌ی پرداخت‌ها تعیین تکلیف شده‌اند." /> : (
        <div className="grid gap-3">
          {data.payments.map((p) => (
            <div key={p.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1 text-sm">
                <div className="text-base font-semibold num">{rial(p.amountRial)}</div>
                <div className="text-muted-foreground">صاحب حساب: <span className="num">{faDigits(p.owner ?? '')}</span> · {faDateTime(p.createdAt)}</div>
                <div className="text-xs text-muted-foreground">کد پیگیری: <span dir="ltr" className="font-mono">{p.refId ?? '—'}</span> · Authority: <span dir="ltr" className="font-mono">{p.authority ?? '—'}</span></div>
                {p.note && <div className="text-xs">{p.note}</div>}
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setTarget({ p, action: 'credit' })}>واریز به کیف پول</Button>
                <Button variant="outline" onClick={() => setTarget({ p, action: 'mark-failed' })}>علامت ناموفق</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {target && <ResolveDialog target={target} onClose={() => setTarget(null)} onDone={reload} />}
    </>
  );
}

function ResolveDialog({ target, onClose, onDone }: { target: { p: Payment; action: Action }; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const credit = target.action === 'credit';
  const submit = async () => {
    setBusy(true);
    try {
      await paymentResolve({ id: target.p.id, action: target.action, note: note.trim() });
      toast.success(credit ? 'مبلغ به کیف پول واریز شد.' : 'پرداخت ناموفق ثبت شد.');
      onClose(); onDone();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>{credit ? 'واریز به کیف پول' : 'ثبت پرداخت ناموفق'}</DialogTitle>
          <DialogDescription>{credit ? `مبلغ ${rial(target.p.amountRial)} به حساب ${target.p.owner} واریز می‌شود. این کار قابل بازگشت نیست.` : 'هیچ مبلغی واریز نمی‌شود. اگر پول از حساب مشتری کسر شده، از طریق درگاه بازگردانده می‌شود.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>توضیح و مستند (حداقل ۵ نویسه)</Label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: در پنل زرین‌پال تأیید شد" />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button>
          <Button variant={credit ? 'default' : 'destructive'} onClick={submit} disabled={busy || note.trim().length < 5}>{busy && <Loader2 className="ms-1 h-4 w-4 animate-spin" />}تأیید</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
