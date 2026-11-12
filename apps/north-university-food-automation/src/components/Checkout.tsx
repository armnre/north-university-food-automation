import { useRef, useState } from 'react';
import { CheckCircle2, CreditCard, Loader2, Lock, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { studentCheckout, type StudentCheckoutOutputType } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@project/components/ui/sheet';
import { toast } from 'sonner';
import { MEALS, errMsg, faDate, rial, newKey, showCode } from '../lib/format';
import { useSession } from '../lib/session';
import type { MenuOffering } from '../lib/types';

type Props = { open: boolean; onOpenChange: (o: boolean) => void; cart: MenuOffering[]; onRemove: (id: string) => void; onPaid: () => void };

const STEPS = ['فاکتور', 'پرداخت', 'رسید'] as const;
function Stepper({ step }: { step: 'invoice' | 'gateway' | 'done' }) {
  const i = step === 'invoice' ? 0 : step === 'gateway' ? 1 : 2;
  return (
    <ol className="mb-4 flex items-center gap-2" aria-label="مراحل پرداخت">
      {STEPS.map((label, k) => (
        <li key={label} className="flex flex-1 items-center gap-2">
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-colors ${k <= i ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{(k + 1).toLocaleString('fa-IR')}</span>
          <span className={`text-xs ${k === i ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{label}</span>
          {k < STEPS.length - 1 && <span className={`h-px flex-1 rounded-full ${k < i ? 'bg-primary' : 'bg-border'}`} />}
        </li>
      ))}
    </ol>
  );
}

export default function CheckoutSheet({ open, onOpenChange, cart, onRemove, onPaid }: Props) {
  const { token } = useSession();
  const [step, setStep] = useState<'invoice' | 'gateway' | 'done'>('invoice');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StudentCheckoutOutputType | null>(null);
  const keyRef = useRef('');
  const total = cart.reduce((s, o) => s + o.priceRial, 0);
  const names = Object.fromEntries(cart.map((o) => [o.id, o]));
  const [snapshot, setSnapshot] = useState<Record<string, MenuOffering>>({});

  const close = (o: boolean) => {
    if (busy) return;
    if (!o) { if (step === 'done') onPaid(); setStep('invoice'); setResult(null); keyRef.current = ''; }
    onOpenChange(o);
  };
  const pay = async () => {
    if (!keyRef.current) keyRef.current = newKey();
    setBusy(true);
    try {
      setSnapshot(names);
      const r = await studentCheckout({ token, offeringIds: cart.map((o) => o.id), idempotencyKey: keyRef.current });
      setResult(r); setStep('done');
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" dir="rtl" className="mx-auto max-h-[92vh] max-w-lg overflow-y-auto rounded-t-[2rem] px-5 pb-safe pt-3">
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-muted" />
        <Stepper step={step} />
        {step === 'invoice' && (
          <>
            <SheetHeader className="text-right"><SheetTitle className="text-xl font-extrabold">فاکتور سفارش</SheetTitle></SheetHeader>
            <ul className="mt-4 space-y-2">
              {cart.map((o) => (
                <li key={o.id} className="flex items-center gap-3 rounded-2xl bg-muted/60 p-3">
                  <div className="min-w-0 flex-1"><div className="truncate font-semibold">{o.foodName}</div><div className="text-xs text-muted-foreground">{MEALS[o.mealType]} · {faDate(o.serviceDate)}</div></div>
                  <span className="num text-sm font-bold">{rial(o.priceRial)}</span>
                  <button onClick={() => onRemove(o.id)} className="grid h-9 w-9 place-items-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="حذف"><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
            {!cart.length && <p className="mt-6 rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">سبد خالی است. از منو غذا اضافه کنید.</p>}
            <div className="mt-4 flex items-center justify-between border-t border-dashed pt-4"><span className="text-muted-foreground">مبلغ قابل پرداخت</span><span className="num text-2xl font-extrabold">{rial(total)}</span></div>
            <Button className="mt-5 h-12 w-full rounded-2xl text-base font-bold" disabled={!cart.length} onClick={() => setStep('gateway')}><CreditCard className="ms-2 h-5 w-5" />انتقال به درگاه پرداخت</Button>
          </>
        )}
        {step === 'gateway' && (
          <>
            <SheetHeader className="text-right"><SheetTitle className="flex items-center gap-2 text-lg"><Lock className="h-4 w-4 text-[hsl(var(--success))]" />درگاه پرداخت امن</SheetTitle></SheetHeader>
            <div className="hero-surface relative mt-4 overflow-hidden rounded-3xl p-5 text-white shadow-[var(--shadow-md)]">
              <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />
              <div className="relative flex items-center justify-between text-sm text-white/75"><span>پذیرنده: دانشگاه شمال</span><ShieldCheck className="h-5 w-5 text-[hsl(var(--sidebar-primary))]" /></div>
              <div className="relative mt-6 text-xs text-white/70">مبلغ تراکنش</div>
              <div className="num relative text-3xl font-extrabold">{rial(total)}</div>
              <div className="relative mt-4 flex items-center justify-between border-t border-white/15 pt-3 text-xs text-white/75">
                <span>{cart.length.toLocaleString('fa-IR')} قلم غذا</span>
                <span className="rounded-full bg-white/10 px-2.5 py-1 font-medium">سامان کیش · شاپرک</span>
              </div>
            </div>
            <ul className="mt-4 space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" />پرداخت روی درگاه رسمی سامان کیش (سپ) انجام می‌شود؛ اطلاعات کارت شما در این سامانه وارد یا ذخیره نمی‌شود.</li>
              <li className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" />پس از پرداخت موفق، رزروها خودکار ثبت و کد رزرو نمایش داده می‌شود.</li>
            </ul>
            {busy && <p className="mt-3 flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-xs font-medium text-primary"><Loader2 className="h-4 w-4 animate-spin" />در حال انتقال امن به درگاه بانک… لطفاً صفحه را نبندید.</p>}
            <div className="mt-5 grid grid-cols-[1fr_2fr] gap-2">
              <Button variant="outline" className="h-12 rounded-2xl" disabled={busy} onClick={() => setStep('invoice')}>بازگشت</Button>
              <Button className="h-12 rounded-2xl text-base font-bold" disabled={busy} onClick={pay}>{busy ? <Loader2 className="ms-2 h-5 w-5 animate-spin" /> : <Lock className="ms-2 h-4 w-4" />}پرداخت {rial(total)}</Button>
            </div>
          </>
        )}
        {step === 'done' && result && (
          <div className="py-4 text-center">
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))] animate-in zoom-in-50"><CheckCircle2 className="h-11 w-11" /></div>
            <h3 className="mt-4 text-xl font-extrabold">پرداخت موفق</h3>
            <p className="mt-1 text-sm text-muted-foreground">کد پیگیری <span dir="ltr" className="font-mono">{result.trackingCode}</span></p>
            <ul className="mt-5 space-y-2 text-right">
              {result.results.map((r) => (
                <li key={r.offeringId} className="flex items-start gap-2 rounded-2xl border p-3 text-sm">
                  {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                  <div className="min-w-0"><div className="font-semibold">{snapshot[r.offeringId]?.foodName ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">{r.ok ? <>کد رزرو <span dir="ltr" className="font-mono">{showCode(r.code)}</span></> : `${r.error} مبلغ این قلم توسط امور مالی به شما بازگردانده می‌شود.`}</div></div>
                </li>
              ))}
            </ul>
            <Button className="mt-5 h-12 w-full rounded-2xl" onClick={() => close(false)}>عالی، متوجه شدم</Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
