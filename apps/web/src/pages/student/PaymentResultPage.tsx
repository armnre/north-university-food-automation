import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react';
import { paymentResult, type PaymentResultDto } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { ErrorState, LoadingBlock, PageHeader, Section } from '../../components/ui-kit';
import { errMsg, faDate, faDateTime, rial, showCode } from '../../lib/format';

export default function PaymentResultPage() {
  const [params] = useSearchParams();
  const paymentId = params.get('paymentId') ?? '';
  const [data, setData] = useState<PaymentResultDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!paymentId) {
      setError('شناسهٔ پرداخت در آدرس صفحه یافت نشد.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await paymentResult(paymentId);
      setData(res);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [paymentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingBlock />;
  if (error || !data) return <ErrorState message={error ?? 'خطا در دریافت رسید پرداخت'} onRetry={load} />;

  const isPaid = data.status === 'Paid';
  const isNeedsReview = data.status === 'NeedsReview';
  const isPending = data.status === 'Pending';

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="رسید پرداخت و رزرو" subtitle={`زمان ثبت: ${faDateTime(data.createdAt)}`} />

      <div className="rounded-3xl border bg-card p-6 text-center shadow-[var(--shadow-sm)]">
        <div
          className={`mx-auto grid h-20 w-20 place-items-center rounded-full ${
            isPaid
              ? 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]'
              : isNeedsReview || isPending
                ? 'bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))]'
                : 'bg-destructive/10 text-destructive'
          }`}
        >
          {isPaid ? (
            <CheckCircle2 className="h-11 w-11" />
          ) : isNeedsReview ? (
            <AlertTriangle className="h-11 w-11" />
          ) : isPending ? (
            <Clock className="h-11 w-11" />
          ) : (
            <XCircle className="h-11 w-11" />
          )}
        </div>

        <h2 className="mt-4 text-xl font-extrabold">
          {isPaid
            ? 'پرداخت تأیید شد'
            : isNeedsReview
              ? 'پرداخت در حال بررسی'
              : isPending
                ? 'در انتظار تأیید درگاه'
                : 'پرداخت ناموفق'}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{data.message}</p>

        <dl className="mt-5 grid grid-cols-2 gap-3 rounded-2xl bg-muted/50 p-4 text-right text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">مبلغ پرداختی درگاه</dt>
            <dd className="num mt-0.5 font-bold">{rial(data.amountRial)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">کسر از اعتبار قبلی</dt>
            <dd className="num mt-0.5 font-bold">{rial(data.creditUsedRial)}</dd>
          </div>
          {data.trackingCode && (
            <div>
              <dt className="text-xs text-muted-foreground">کد رهگیری سامانه</dt>
              <dd className="mt-0.5 font-mono text-xs font-semibold" dir="ltr">
                {data.trackingCode}
              </dd>
            </div>
          )}
          {data.refId && (
            <div>
              <dt className="text-xs text-muted-foreground">کد مرجع بانکی (RefID)</dt>
              <dd className="mt-0.5 font-mono text-xs font-semibold" dir="ltr">
                {data.refId}
              </dd>
            </div>
          )}
          {data.refundedToWalletRial > 0 && (
            <div className="col-span-2 rounded-xl border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] p-3 text-xs">
              بابت آیتم‌هایی که حین پرداخت ظرفیتشان تکمیل یا مهلتشان تمام شد، مبلغ{' '}
              <b className="num">{rial(data.refundedToWalletRial)}</b> به اعتبار کیف پول شما منتقل گردید. ماندهٔ فعلی اعتبار:{' '}
              <b className="num">{rial(data.balanceRial)}</b>
            </div>
          )}
        </dl>
      </div>

      {data.items.length > 0 && (
        <Section title="وضعیت آیتم‌های سفارش">
          <ul className="divide-y">
            {data.items.map((item) => (
              <li key={item.offeringId} className="flex items-start justify-between gap-3 py-3 text-sm">
                <div className="flex items-start gap-2.5">
                  {item.ok ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--success))]" />
                  ) : (
                    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                  )}
                  <div>
                    <div className="font-semibold">{item.foodName}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.mealSlotTitle ? `${item.mealSlotTitle} · ` : ''}
                      {faDate(item.serviceDate)}
                    </div>
                    {!item.ok && item.error && <div className="mt-1 text-xs text-destructive">{item.error}</div>}
                  </div>
                </div>
                <div className="text-left">
                  <div className="num font-semibold">{rial(item.priceRial)}</div>
                  {item.ok && item.code && (
                    <div className="mt-0.5 font-mono text-xs font-bold text-primary" dir="ltr">
                      {showCode(item.code)}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="flex flex-wrap gap-3">
        {isPaid ? (
          <Button asChild className="h-11 flex-1 rounded-xl">
            <Link to="/reservations">مشاهدهٔ رزروها و کارت تحویل (QR)</Link>
          </Button>
        ) : (
          <Button asChild className="h-11 flex-1 rounded-xl">
            <Link to="/menu">بازگشت به منوی غذا</Link>
          </Button>
        )}
        {(isPending || isNeedsReview) && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={load}>
            <RefreshCw className="ms-2 h-4 w-4" />
            بروزرسانی وضعیت
          </Button>
        )}
      </div>
    </div>
  );
}
