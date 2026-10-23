import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CreditCard, Info, Loader2, ReceiptText, Trash2, XCircle } from 'lucide-react';
import { checkoutStart, paymentStatus, studentWallet, type CheckoutStartDto } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@project/components/ui/sheet';
import { toast } from 'sonner';
import { MEALS, errMsg, faDate, newKey, rial, showCode } from '../lib/format';
import type { MenuOffering, Wallet } from '../lib/types';

/**
 * سبد خرید با پرداخت مستقیم درگاه و کسر خودکار اعتبار قبلی کیف پول.
 *
 *  - اگر اعتبار بازگشتی قبلی کل سفارش را پوشش دهد (`payableRial === 0`)، رزرو بلافاصله و اتمیک ثبت می‌شود.
 *  - در غیر این صورت، اعتبار قبلی به‌صورت خودکار کسر شده و فقط مابه‌التفاوت به درگاه پرداخت ارسال می‌گردد.
 *  - اگر درگاه غیرفعال باشد، دکمهٔ پرداخت غیرفعال شده و پیام راهنما نمایش داده می‌شود.
 */

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cart: MenuOffering[];
  onRemove: (id: string) => void;
  onPaid: () => void;
};

export default function CheckoutSheet({ open, onOpenChange, cart, onRemove, onPaid }: Props) {
  const [step, setStep] = useState<'invoice' | 'done'>('invoice');
  const [busy, setBusy] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const [balanceRial, setBalanceRial] = useState(0);
  const [gatewayState, setGatewayState] = useState<{ enabled: boolean; minPayableRial: number; message: string }>({
    enabled: false,
    minPayableRial: 10_000,
    message: 'درگاه پرداخت اینترنتی در حال حاضر فعال نیست.',
  });
  const [result, setResult] = useState<CheckoutStartDto | null>(null);
  const keyRef = useRef('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    setMetaLoading(true);
    Promise.all([studentWallet(), paymentStatus()])
      .then(([w, p]) => {
        if (!active) return;
        const wallet = w as unknown as Wallet;
        setBalanceRial(wallet.balanceRial ?? 0);
        setGatewayState({
          enabled: p.enabled,
          minPayableRial: Math.max(p.minPayableRial ?? 10_000, 10_000),
          message: p.message,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setMetaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const totalRial = useMemo(() => cart.reduce((s, o) => s + (o.myPriceRial ?? o.priceRial ?? 0), 0), [cart]);

  const breakdown = useMemo(() => {
    if (totalRial <= 0) {
      return { creditUsedRial: 0, payableRial: 0, minPayableNote: null as string | null, belowGatewayMin: false };
    }
    if (balanceRial >= totalRial) {
      return { creditUsedRial: totalRial, payableRial: 0, minPayableNote: null, belowGatewayMin: false };
    }
    const minPayable = gatewayState.minPayableRial;
    if (totalRial < minPayable) {
      return {
        creditUsedRial: 0,
        payableRial: totalRial,
        minPayableNote: null,
        belowGatewayMin: true,
      };
    }
    const rawPayable = totalRial - balanceRial;
    if (rawPayable < minPayable) {
      const creditUsed = totalRial - minPayable;
      const kept = balanceRial - creditUsed;
      return {
        creditUsedRial: creditUsed,
        payableRial: minPayable,
        minPayableNote: `به دلیل حداقل مبلغ تراکنش درگاه بانکی (${rial(minPayable)})، مبلغ ${rial(kept)} از اعتبار شما برای رزروهای بعدی در کیف پول باقی می‌ماند.`,
        belowGatewayMin: false,
      };
    }
    return { creditUsedRial: balanceRial, payableRial: rawPayable, minPayableNote: null, belowGatewayMin: false };
  }, [totalRial, balanceRial, gatewayState.minPayableRial]);

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
      const response = await checkoutStart({
        items: cart.map((o) => ({ offeringId: o.id })),
        idempotencyKey: keyRef.current,
      });
      if (response.mode === 'gateway' && response.redirectUrl) {
        window.location.assign(response.redirectUrl);
        return;
      }
      setResult(response);
      setStep('done');
      toast.success('رزرو شما با موفقیت ثبت شد.');
    } catch (e) {
      keyRef.current = '';
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const needsGateway = breakdown.payableRial > 0;
  const gatewayBlocked = needsGateway && !gatewayState.enabled;

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" dir="rtl" className="mx-auto max-h-[92vh] max-w-lg overflow-y-auto rounded-t-[2rem] px-5 pb-safe pt-3">
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-muted" />
        {step === 'invoice' && (
          <>
            <SheetHeader className="text-right">
              <SheetTitle className="text-xl font-extrabold">سبد سفارش و پرداخت</SheetTitle>
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
                  <span className="num text-sm font-bold">{rial(o.myPriceRial ?? o.priceRial)}</span>
                  <button
                    onClick={() => {
                      keyRef.current = '';
                      onRemove(o.id);
                    }}
                    className="grid h-11 w-11 place-items-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`حذف ${o.foodName} از سبد`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-4 space-y-2 rounded-2xl border bg-card p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">جمع کل سفارش</span>
                <span className="num font-semibold">{rial(totalRial)}</span>
              </div>
              {breakdown.creditUsedRial > 0 && (
                <div className="flex items-center justify-between text-[hsl(var(--success))]">
                  <span>کسر خودکار از اعتبار کیف پول</span>
                  <span className="num font-semibold" dir="ltr">
                    −{rial(breakdown.creditUsedRial)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-dashed pt-3">
                <span className="font-semibold">
                  {breakdown.payableRial === 0 ? 'مبلغ قابل پرداخت درگاه' : 'مبلغ قابل پرداخت آنلاین'}
                </span>
                <span className="num text-xl font-extrabold">{rial(breakdown.payableRial)}</span>
              </div>
            </div>

            {breakdown.minPayableNote && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border bg-accent p-3 text-xs leading-5 text-accent-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{breakdown.minPayableNote}</span>
              </div>
            )}

            {breakdown.belowGatewayMin && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>حداقل مبلغ قابل پرداخت در درگاه بانکی {rial(gatewayState.minPayableRial)} است.</span>
              </div>
            )}

            {!metaLoading && gatewayBlocked && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] p-3 text-xs leading-5">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" />
                <span>{gatewayState.message} برای راهنمایی با امور مالی تغذیه در ارتباط باشید.</span>
              </div>
            )}

            <Button
              className="mt-5 h-12 w-full rounded-2xl text-base font-bold"
              disabled={!cart.length || busy || metaLoading || gatewayBlocked || breakdown.belowGatewayMin}
              onClick={submit}
            >
              {busy || metaLoading ? (
                <Loader2 className="ms-2 h-5 w-5 animate-spin" />
              ) : needsGateway ? (
                <CreditCard className="ms-2 h-5 w-5" />
              ) : (
                <ReceiptText className="ms-2 h-5 w-5" />
              )}
              {needsGateway ? 'پرداخت اینترنتی و ثبت رزرو' : 'ثبت قطعی رزرو (با اعتبار کیف پول)'}
            </Button>
          </>
        )}

        {step === 'done' && result && (
          <div className="py-4 text-center">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))] animate-in zoom-in-50">
              <CheckCircle2 className="h-11 w-11" />
            </div>
            <h3 className="mt-4 text-xl font-extrabold">{result.items.length.toLocaleString('fa-IR')} وعده رزرو شد</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              کسر از اعتبار: <span className="num font-bold">{rial(result.creditUsedRial)}</span> · ماندهٔ اعتبار فعلی:{' '}
              <span className="num font-bold">{rial(result.balanceRial)}</span>
            </p>
            <ul className="mt-5 space-y-2 text-right">
              {result.items.map((r) => (
                <li key={r.offeringId} className="flex items-start gap-2 rounded-2xl border p-3 text-sm">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" />
                  <div className="min-w-0">
                    <div className="font-semibold">{r.foodName}</div>
                    <div className="text-xs text-muted-foreground">
                      کد رزرو <span dir="ltr" className="font-mono font-bold">{showCode(r.code)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Button className="mt-5 h-12 w-full rounded-2xl" onClick={() => close(false)}>
              مشاهدهٔ رزروها و بستن
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
