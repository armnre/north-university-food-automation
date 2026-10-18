import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@project/components/ui/dialog';
import { MEALS, faDate } from '../lib/format';

export type QrTarget = { qrToken: string; code: string; foodName: string; mealType: string; serviceDate: string; cafeteriaName: string };

/** The QR encodes only a random 48-hex token. No national id, name or money data. */
export default function QrDialog({ target, onClose }: { target: QrTarget | null; onClose: () => void }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!target) return;
    QRCode.toDataURL(target.qrToken, { width: 320, margin: 1, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [target]);
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>کد تحویل غذا</DialogTitle>
          <DialogDescription>این کد را هنگام دریافت غذا به اپراتور سلف نشان دهید.</DialogDescription>
        </DialogHeader>
        {target && (
          <div className="flex flex-col items-center">
            <div className="rounded-2xl border-4 border-primary bg-white p-3">{src ? <img src={src} alt="کد QR رزرو" className="h-64 w-64" /> : <div className="h-64 w-64 animate-pulse bg-muted" />}</div>
            <div className="mt-4 text-center">
              <div className="text-lg font-bold">{target.foodName}</div>
              <div className="text-sm text-muted-foreground">{MEALS[target.mealType]} · {faDate(target.serviceDate)}</div>
              <div className="text-sm text-muted-foreground">{target.cafeteriaName}</div>
              <div className="mt-2 font-mono text-sm tracking-widest" dir="ltr">{target.code}</div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
