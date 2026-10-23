import { Bell, LifeBuoy } from 'lucide-react';
import { studentNotifications } from '../../lib/api';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill, Section } from '../../components/ui-kit';
import { faDateTime } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { StudentNotifs } from '../../lib/types';

const DEFAULT_HELP = [
  ['چگونه غذا رزرو کنم؟', 'از «منوی غذا» روز را انتخاب کنید، روی «جزئیات و رزرو» بزنید و رزرو را تأیید کنید. مبلغ از کیف پول کسر می‌شود.'],
  ['چگونه سفارش بدهم؟', 'در «منوی غذا» غذاهای دلخواه را به سبد اضافه کنید، سپس روی «پرداخت» بزنید تا جمع فاکتور از طریق درگاه پرداخت شود. امکان لغو رزرو فعلاً وجود ندارد.'],
  ['غذا را چگونه تحویل بگیرم؟', 'در روز وعده، کد QR رزرو را از «رزروهای من» باز کنید و به اپراتور سلف نشان دهید. هر کد فقط یک‌بار قابل استفاده است.'],
  ['کیف پول را چگونه شارژ کنم؟', 'پرداخت اینترنتی فعلاً فعال نیست. شارژ از طریق امور مالی تغذیه انجام می‌شود.'],
];

export default function NotificationsPage({ mode }: { mode: 'notifications' | 'help' }) {
  const { data, error, loading, reload } = useLoad(async () => (await studentNotifications()) as StudentNotifs);
  if (loading) return <LoadingBlock />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (mode === 'help') {
    return (
      <>
        <PageHeader title="راهنما و پشتیبانی" />
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Section title="پرسش‌های پرتکرار">
            {data.helpText ? <p className="whitespace-pre-line text-sm leading-7">{data.helpText}</p> : (
              <dl className="space-y-4">{DEFAULT_HELP.map(([q, a]) => <div key={q}><dt className="font-semibold">{q}</dt><dd className="mt-1 text-sm leading-7 text-muted-foreground">{a}</dd></div>)}</dl>
            )}
          </Section>
          <Section title="ارتباط با پشتیبانی">
            <div className="flex gap-3 text-sm leading-7"><LifeBuoy className="mt-1 h-5 w-5 shrink-0 text-primary" /><p className="whitespace-pre-line">{data.supportText || 'اطلاعات تماس پشتیبانی هنوز توسط مدیر سامانه ثبت نشده است.'}</p></div>
          </Section>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title="اعلان‌ها" />
      {data.notifications.length === 0 ? <EmptyState title="اعلانی ندارید" /> : (
        <div className="space-y-3">
          {data.notifications.map((n) => (
            <article key={n.id} className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 font-semibold"><Bell className="h-4 w-4 text-primary" />{n.title}</h3>
                {n.personal && <Pill tone="info">شخصی</Pill>}
              </div>
              <p className="mt-2 whitespace-pre-line text-sm leading-7 text-muted-foreground">{n.body}</p>
              <div className="mt-2 text-xs text-muted-foreground">{faDateTime(n.createdAt)}</div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
