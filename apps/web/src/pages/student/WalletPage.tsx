import { Wallet as WalletIcon, Info } from 'lucide-react';
import { studentWallet } from '../../lib/api';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, StatCard, Section } from '../../components/ui-kit';
import { LEDGER_TYPES, faDateTime, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { cn } from '@project/components/lib/utils';
import type { Wallet } from '../../lib/types';

export default function WalletPage() {
  const { data, error, loading, reload } = useLoad(async () => (await studentWallet()) as Wallet);
  if (loading) return <LoadingBlock />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  return (
    <>
      <PageHeader title="کیف پول" subtitle="موجودی از روی سوابق مالی ثبت‌شده محاسبه می‌شود." />
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard tone="primary" label="موجودی فعلی" value={rial(data.balanceRial)} icon={<WalletIcon className="h-5 w-5" />} />
        <div className="flex items-start gap-3 rounded-xl border bg-accent p-4 text-sm text-accent-foreground">
          <Info className="mt-0.5 h-5 w-5 shrink-0" />
          <p>پرداخت اینترنتی در حال حاضر فعال نیست. برای شارژ کیف پول به امور مالی تغذیه مراجعه کنید.</p>
        </div>
      </div>
      <Section title="تاریخچه‌ی تراکنش‌ها" className="mt-6">
        {data.transactions.length === 0 ? <EmptyState title="هنوز تراکنشی ثبت نشده است" /> : (
          <ul className="divide-y">
            {data.transactions.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{LEDGER_TYPES[t.type] ?? t.type}</div>
                  <div className="truncate text-xs text-muted-foreground">{faDateTime(t.createdAt)} · <span dir="ltr" className="font-mono">{t.trackingCode}</span>{t.reason && ` · ${t.reason}`}</div>
                </div>
                <div className="text-left">
                  <div className={cn('num font-bold', t.amountRial >= 0 ? 'text-[hsl(var(--success))]' : 'text-destructive')} dir="ltr">{t.amountRial >= 0 ? '+' : '−'}{rial(Math.abs(t.amountRial))}</div>
                  <div className="num text-xs text-muted-foreground">مانده: {rial(t.runningBalance)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
