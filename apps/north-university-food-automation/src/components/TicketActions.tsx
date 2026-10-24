import { RefreshCw, XCircle } from 'lucide-react';
import ConfirmButton from './ConfirmButton';
import { studentCancelReservation, studentReissueQr } from '../lib/api';
import { faDateTime, rial } from '../lib/format';

type R = { id: string; priceAtBooking: number; canCancel: boolean; cancelDeadline: string | null };

/** Cancel (refund to wallet, only before the deadline and when enabled) and re-issue QR for an active ticket. */
export default function TicketActions({ r, onDone }: { r: R; onDone: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      {r.canCancel && (
        <ConfirmButton size="sm" variant="ghost" className="h-8 text-destructive" title="لغو رزرو" confirmLabel="بله، لغو شود"
          description={<>مبلغ {rial(r.priceAtBooking)} به اعتبار کیف پول شما برمی‌گردد. این کار قابل بازگشت نیست.</>}
          action={async () => { const o = await studentCancelReservation({ id: r.id }); onDone(); return o.replay ? 'این رزرو قبلاً لغو شده بود.' : 'رزرو لغو شد و مبلغ به کیف پول برگشت.'; }}>
          <XCircle className="ms-1 h-3.5 w-3.5" />لغو رزرو
        </ConfirmButton>
      )}
      <ConfirmButton size="sm" variant="ghost" className="h-8" title="صدور کیو‌آر جدید" confirmLabel="صدور کیو‌آر جدید"
        description="کیو‌آر قبلی (مثلاً اگر عکسش را برای کسی فرستاده‌اید) باطل می‌شود و فقط کیو‌آر جدید برای تحویل معتبر است."
        action={async () => { await studentReissueQr({ id: r.id }); onDone(); return 'کیو‌آر جدید صادر شد.'; }}>
        <RefreshCw className="ms-1 h-3.5 w-3.5" />کیو‌آر جدید
      </ConfirmButton>
      {!r.canCancel && r.cancelDeadline && <span className="text-[11px] text-muted-foreground">مهلت لغو: {faDateTime(r.cancelDeadline)}</span>}
    </div>
  );
}
