import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, QrCode, Wallet as WalletIcon } from 'lucide-react';
import { studentReservations, studentWallet } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { ErrorState, LoadingBlock, PageHeader, Pill, Section, StatCard, EmptyState } from '../../components/ui-kit';
import QrDialog, { type QrTarget } from '../../components/QrDialog';
import { MEALS, RES_STATUS, faDate, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import type { StudentMe } from '../../lib/session';
import type { MyReservations, Wallet } from '../../lib/types';

export default function StudentDashboard({ me }: { me: StudentMe }) {
  const { data, error, loading, reload } = useLoad(async (token) => {
    const [w, r] = await Promise.all([studentWallet({ token }), studentReservations({ token })]);
    return { w: w as Wallet, r: r as MyReservations };
  });
  const [qr, setQr] = useState<QrTarget | null>(null);
  if (loading) return <LoadingBlock />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  const upcoming = data.r.reservations.filter((x) => x.status === 'Reserved').sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
  const todays = upcoming.filter((x) => x.serviceDate === data.r.today);
  return (
    <>
      <PageHeader title={`سلام، ${me.fullName.split(' ')[0] || 'دانشجوی گرامی'}`} subtitle={faDate(data.r.today)} actions={<Button asChild><Link to="/menu"><CalendarDays className="ms-1 h-4 w-4" />رزرو غذا</Link></Button>} />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard tone="primary" label="موجودی کیف پول" value={rial(data.w.balanceRial)} icon={<WalletIcon className="h-5 w-5" />} hint={<Link to="/wallet" className="underline-offset-2 hover:underline">مشاهده‌ی تراکنش‌ها</Link>} />
        <StatCard label="رزروهای پیش رو" value={faNum(upcoming.length)} />
        <StatCard label="غذاهای تحویل‌شده" value={faNum(data.r.reservations.filter((x) => x.status === 'Delivered').length)} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="غذای امروز">
          {todays.length === 0 ? <EmptyState title="برای امروز رزروی ندارید" action={<Button variant="outline" asChild><Link to="/menu">مشاهده‌ی منو</Link></Button>} /> : (
            <div className="space-y-3">
              {todays.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div><div className="font-semibold">{r.foodName}</div><div className="text-sm text-muted-foreground">{MEALS[r.mealType]} · {r.cafeteriaName}</div></div>
                  {r.qrToken && <Button size="sm" onClick={() => setQr({ ...r, qrToken: r.qrToken! })}><QrCode className="ms-1 h-4 w-4" />نمایش QR</Button>}
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="رزروهای پیش رو" actions={<Link to="/reservations" className="flex items-center gap-1 text-sm text-primary">همه<ArrowLeft className="h-4 w-4" /></Link>}>
          {upcoming.length === 0 ? <p className="text-sm text-muted-foreground">رزرو فعالی ندارید.</p> : (
            <ul className="divide-y">
              {upcoming.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                  <span><span className="font-medium">{r.foodName}</span> <span className="text-muted-foreground">· {MEALS[r.mealType]} · {faDate(r.serviceDate)}</span></span>
                  <Pill tone={RES_STATUS[r.status].tone}>{RES_STATUS[r.status].label}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <QrDialog target={qr} onClose={() => setQr(null)} />
    </>
  );
}
