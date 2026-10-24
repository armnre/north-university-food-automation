import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Button } from '@project/components/ui/button';
import { cn } from '@project/components/lib/utils';
import { paymentResult, type StudentCheckoutOutputType } from '../../lib/api';
import { errMsg, rial, showCode } from '../../lib/format';
import { ErrorState, LoadingBlock, Section } from '../../components/ui-kit';

/** Landing page after Zarinpal redirects back. The server has already verified; this only reads the outcome. */
export default function PaymentResultPage() {
  const [params] = useSearchParams();
  const pid = params.get('pid');
  const [data, setData] = useState<StudentCheckoutOutputType | null>(null);
  const [err, setErr] = useState(params.get('error') ? 'بازگشت از درگاه نامعتبر بود. اگر مبلغی کسر شده، بررسی و تعیین‌تکلیف می‌شود.' : '');
  useEffect(() => { if (pid) paymentResult(pid).then(setData).catch((e) => setErr(errMsg(e))); }, [pid]);

  if (err || !pid) return <ErrorState message={err || 'شناسه پرداخت پیدا نشد.'} />;
  if (!data) return <LoadingBlock rows={3} />;
  const paid = data.status === 'Paid';
  const review = data.status === 'NeedsReview' || data.status === 'Pending';
  const Icon = paid ? CheckCircle2 : review ? Clock : XCircle;
  const tone = paid ? 'text-[hsl(var(--success))] bg-[hsl(var(--success)/0.12)]' : review ? 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.12)]' : 'text-destructive bg-destructive/10';
  return (
    <Section className="mx-auto max-w-lg text-center">
      <div className={cn('mx-auto grid h-20 w-20 place-items-center rounded-full', tone)}><Icon className="h-11 w-11" /></div>
      <h1 className="mt-4 text-xl font-extrabold">{paid ? 'پرداخت موفق' : review ? 'پرداخت در حال بررسی' : 'پرداخت ناموفق'}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {paid ? <>کد پیگیری <span dir="ltr" className="font-mono">{data.trackingCode ?? '—'}</span> · مبلغ {rial(data.paidRial)}</>
          : review ? 'نتیجه‌ی این پرداخت قطعی نشده؛ پس از بررسی، رزرو انجام یا مبلغ به کیف پول برگردانده می‌شود.'
          : 'مبلغی از حساب شما برداشت نشد یا به‌طور خودکار برمی‌گردد.'}
      </p>
      {paid && (
        <ul className="mt-5 space-y-2 text-right">
          {data.results.map((r) => (
            <li key={r.offeringId} className="flex items-start gap-2 rounded-2xl border p-3 text-sm">
              {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
              <span>{r.ok ? <>کد رزرو <span dir="ltr" className="font-mono">{showCode(r.code)}</span></> : r.error}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Button asChild variant="outline"><Link to="/menu">منوی غذا</Link></Button>
        <Button asChild><Link to="/reservations">رزروهای من</Link></Button>
      </div>
    </Section>
  );
}
