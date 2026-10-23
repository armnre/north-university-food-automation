import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Loader2, ReceiptText, Trash2, Wallet, XCircle } from 'lucide-react';
import { studentCheckout } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@project/components/ui/sheet';
import { toast } from 'sonner';
import { MEALS, errMsg, faDate, newKey, showCode, tomanText } from '../lib/format';
import type { MenuOffering } from '../lib/types';

/**
 * سبد خرید.
 *
 * تفاوت اساسی با نسخهٔ قبلی: **هیچ اعتباری بدون پرداخت تأییدشده ثبت نمی‌شود.**
 * رزروها مستقیماً از موجودی کیف پول کسر می‌شوند؛ اگر موجودی کافی نباشد،
 * مبلغ کسری نمایش داده می‌شود و دکمهٔ «شارژ و ادامه» کاربر را به کیف پول می‌برد.
 */

type CheckoutResult = {
  results: { offeringId: string; ok: boolean; code: string | null; error: string | null; errorCode: string | null; priceRial: number }[];
  succeeded: number;
  failed: number;
  paidRial: number;
  balanceRial: number;
  shortfallRial: number;
};

type Props = { open: boolean; onOpenChange: (o: boolean) => void; cart: MenuOffering[]; onRemove: (id: string) => void; onPaid: () => void };

export default function CheckoutSheet({ open, onOpenChange, cart, onRemove, onPaid }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<'invoice' | 'done'>('invoice');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const keyRef = useRef('');
  const total = cart.reduce((s, o) => s + (o.myPriceRial ?? o.priceRial ?? 0), 0);
  const snapshot = useMemo(() => Object.fromEntries(cart.map((o) => [o.id, o])), [cart]);

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) {
      if (step === 'done') onPaid();
      setStep('invoice');
      setResult(null);
      keyRef.current = '';
    }
    onOpenChange(o);
  };

  const submit = async () => {
    if (!keyRef.current) keyRef.current = newKey();
    setBusy(true);
    try {
      const response = (await studentCheckout({ offeringIds: cart.map((o) => o.id), idempotencyKey: keyRef.current })) as unknown as CheckoutResult;
      setResult(response);
      setStep('done');
      if (response.succeeded > 0) toast.success(`${response.succeeded} وعده با موفقیت رزرو شد.`);
      if (response.failed > 0 && response.shortfallRial > 0) {
        toast.error(`موجودی کافی نیست؛ کسری ${tomanText(response.shortfallRial)}.`);
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" dir="rtl" className="mx-auto max-h-[92vh] max-w-lg overflow-y-auto rounded-t-[2rem] px-5 pb-safe pt-3">
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-muted" />
        {step === 'invoice' && (
          <>
            <SheetHeader className="text-right">
              <SheetTitle className="text-xl font-extrabold">سبد سفارش</SheetTitle>
            </SheetHeader>
            <ul className="mt-4 space-y-2">
              {cart.map((o) => (
                <li key={o.id} className="flex items-center gap-3 rounded-2xl bg-muted/60 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{o.foodName}</div>
                    <div className="text-xs text-muted-foreground">
                      {MEALS[o.mealSlot] ?? o.mealSlot} · {faDate(o.serviceDate)}
                    </div>
                  </div>
                  <span className="num text-sm font-bold">{tomanText(o.myPriceRial ?? o.priceRial)}</span>
                  <button
                    onClick={() => onRemove(o.id)}
                    className="grid h-11 w-11 place-items-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`حذف ${o.foodName} از سبد`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center justify-between border-t border-dashed pt-4">
              <span className="text-muted-foreground">مبلغ قابل پرداخت از کیف پول</span>
              <span className="num text-2xl font-extrabold">{tomanText(total)}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              مبلغ مستقیماً از موجودی کیف پول کسر می‌شود. اگر موجودی کافی نباشد، رزرو انجام نمی‌شود و باید کیف پول را شارژ کنید.
            </p>
            <Button className="mt-5 h-12 w-full rounded-2xl text-base font-bold" disabled={!cart.length || busy} onClick={submit}>
              {busy ? <Loader2 className="ms-2 h-5 w-5 animate-spin" /> : <ReceiptText className="ms-2 h-5 w-5" />}
              ثبت رزرو از کیف پول
            </Button>
          </>
        )}
        {step === 'done' && result && (
          <div className="py-4 text-center">
            <div
              className={`mx-auto grid h-20 w-20 place-items-center rounded-full animate-in zoom-in-50 ${
                result.succeeded > 0 ? 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]' : 'bg-destructive/10 text-destructive'
              }`}
            >
              {result.succeeded > 0 ? <CheckCircle2 className="h-11 w-11" /> : <XCircle className="h-11 w-11" />}
            </div>
            <h3 className="mt-4 text-xl font-extrabold">{result.succeeded > 0 ? `${result.succeeded} وعده رزرو شد` : 'رزرو انجام نشد'}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              مبلغ کسر شده: <span className="num font-bold">{tomanText(result.paidRial)}</span> · موجودی فعلی:{' '}
              <span className="num font-bold">{tomanText(result.balanceRial)}</span>
            </p>
            {result.shortfallRial > 0 && (
              <div className="mt-4 rounded-2xl bg-[hsl(var(--warning)/0.12)] p-4 text-right">
                <p className="text-sm font-bold text-[hsl(var(--warning))]">کسری موجودی: {tomanText(result.shortfallRial)}</p>
                <p className="mt-1 text-xs text-muted-foreground">برای رزرو وعده‌های باقی‌مانده، کیف پول خود را شارژ کنید.</p>
                <Button
                  className="mt-3 h-11 w-full rounded-2xl"
                  onClick={() => {
                    close(false);
                    navigate('/wallet');
                  }}
                >
                  <Wallet className="ms-2 h-4 w-4" />
                  شارژ و ادامه
                </Button>
              </div>
            )}
            <ul className="mt-5 space-y-2 text-right">
              {result.results.map((r) => (
                <li key={r.offeringId} className="flex items-start gap-2 rounded-2xl border p-3 text-sm">
                  {r.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold">{snapshot[r.offeringId]?.foodName ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.ok ? (
                        <>
                          کد رزرو <span dir="ltr" className="font-mono">{showCode(r.code)}</span>
                        </>
                      ) : (
                        r.error ?? 'رزرو انجام نشد.'
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Button className="mt-5 h-12 w-full rounded-2xl" onClick={() => close(false)}>
              بستن
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
