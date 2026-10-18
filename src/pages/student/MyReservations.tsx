import { useState } from 'react';
import { QrCode, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { studentCancel, studentReservations } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@project/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger } from '@project/components/ui/tabs';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import QrDialog, { type QrTarget } from '../../components/QrDialog';
import { MEALS, RES_STATUS, errMsg, faDate, faDateTime, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { MyReservation, MyReservations as Data } from '../../lib/types';

export default function MyReservations() {
  const { token } = useSession();
  const { data, error, loading, reload } = useLoad(async (t) => (await studentReservations({ token: t })) as Data);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [qr, setQr] = useState<QrTarget | null>(null);
  const [cancel, setCancel] = useState<MyReservation | null>(null);
  const [busy, setBusy] = useState(false);
  const doCancel = async () => {
    if (!cancel) return;
    setBusy(true);
    try { const r = await studentCancel({ token, reservationId: cancel.id }); toast.success(`رزرو لغو شد و ${rial(r.refunded)} به کیف پول برگشت.`); setCancel(null); reload(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };
  const rows = (data?.reservations ?? []).filter((r) => (tab === 'upcoming' ? r.status === 'Reserved' : r.status !== 'Reserved'));
  return (
    <>
      <PageHeader title="رزروهای من" subtitle="وضعیت رزروها، کد تحویل و لغو در مهلت مجاز" />
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'upcoming' | 'past')} className="mb-4">
        <TabsList><TabsTrigger value="upcoming">فعال</TabsTrigger><TabsTrigger value="past">سوابق</TabsTrigger></TabsList>
      </Tabs>
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? <EmptyState title={tab === 'upcoming' ? 'رزرو فعالی ندارید' : 'سابقه‌ای ثبت نشده است'} /> : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{r.foodName}</span><Pill tone={RES_STATUS[r.status]?.tone ?? 'muted'}>{RES_STATUS[r.status]?.label ?? r.status}</Pill></div>
                <div className="mt-1 text-sm text-muted-foreground">{MEALS[r.mealType]} · {faDate(r.serviceDate)} · {r.cafeteriaName}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <span className="num">{rial(r.priceAtBooking)}</span> · کد <span dir="ltr" className="font-mono">{r.code}</span>
                  {r.deliveredAt && <> · تحویل: {faDateTime(r.deliveredAt)}</>}
                  {r.status === 'Reserved' && <> · مهلت لغو: {faDateTime(r.cancelDeadline)}</>}
                </div>
              </div>
              {r.status === 'Reserved' && (
                <div className="flex gap-2">
                  {r.qrToken && <Button size="sm" onClick={() => setQr({ ...r, qrToken: r.qrToken! })}><QrCode className="ms-1 h-4 w-4" />QR تحویل</Button>}
                  <Button size="sm" variant="outline" disabled={!r.canCancel} title={r.canCancel ? '' : 'مهلت لغو گذشته است'} onClick={() => setCancel(r)}><XCircle className="ms-1 h-4 w-4" />لغو</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <QrDialog target={qr} onClose={() => setQr(null)} />
      <AlertDialog open={!!cancel} onOpenChange={(o) => !o && !busy && setCancel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>لغو رزرو</AlertDialogTitle>
            <AlertDialogDescription>رزرو «{cancel?.foodName}» لغو و مبلغ {cancel ? rial(cancel.priceAtBooking) : ''} به کیف پول شما بازگردانده می‌شود. این عملیات قابل بازگشت نیست.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={busy}>انصراف</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); doCancel(); }} className="bg-destructive text-destructive-foreground">تأیید لغو</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
