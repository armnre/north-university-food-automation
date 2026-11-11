import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, MapPin, Sun, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { MEALS, faDate } from '../lib/format';

export type QrTarget = { qrToken: string; code: string; foodName: string; mealType: string; serviceDate: string; cafeteriaName: string };

/** Meal ticket: QR encodes only a random token. Manual code is shown large for the operator. */
export default function QrDialog({ target, onClose }: { target: QrTarget | null; onClose: () => void }) {
  const [src, setSrc] = useState('');
  const [mode, setMode] = useState<'qr' | 'code'>('qr');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!target) return;
    setMode('qr'); setSrc('');
    QRCode.toDataURL(target.qrToken, { width: 560, margin: 1, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [target]);
  const copy = async () => { if (!target) return; await navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const code = target?.code.replace(/^R-/, '') ?? '';
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="h-[100dvh] max-h-[100dvh] max-w-full overflow-y-auto rounded-none border-0 bg-[hsl(var(--sidebar-background))] p-0 sm:h-auto sm:max-w-sm sm:rounded-[2rem] [&>button]:hidden">
        <DialogTitle className="sr-only">بلیط غذا</DialogTitle>
        <DialogDescription className="sr-only">کد تحویل غذا</DialogDescription>
        {target && (
          <div className="flex min-h-full flex-col px-5 pb-safe pt-5">
            <div className="flex items-center justify-between text-white">
              <span className="text-sm font-semibold text-white/80">بلیط غذا</span>
              <button onClick={onClose} aria-label="بستن" className="grid h-10 w-10 place-items-center rounded-full bg-white/10"><X className="h-5 w-5" /></button>
            </div>
            <div className="my-auto py-4">
              <div className="overflow-hidden rounded-[1.75rem] bg-card shadow-[var(--shadow-xl)] animate-in zoom-in-95">
                <div className="hero-surface px-5 pb-5 pt-4 text-white">
                  <div className="text-xs text-white/70">{MEALS[target.mealType]} · {faDate(target.serviceDate)}</div>
                  <div className="mt-1 text-2xl font-extrabold">{target.foodName}</div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-white/75"><MapPin className="h-3 w-3" />{target.cafeteriaName}</div>
                </div>
                <div className="relative h-0 border-t-2 border-dashed border-border">
                  <span className="absolute -right-3 -top-3 h-6 w-6 rounded-full bg-[hsl(var(--sidebar-background))]" />
                  <span className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-[hsl(var(--sidebar-background))]" />
                </div>
                <div className="p-5">
                  <div className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1">
                    {(['qr', 'code'] as const).map((m) => (
                      <button key={m} onClick={() => setMode(m)} className={cn('h-10 rounded-xl text-sm font-semibold transition', mode === m ? 'bg-card shadow-[var(--shadow-sm)]' : 'text-muted-foreground')}>{m === 'qr' ? 'کیو‌آر کد' : 'کد دستی'}</button>
                    ))}
                  </div>
                  {mode === 'qr' ? (
                    <div className="mx-auto aspect-square w-full max-w-[280px] rounded-2xl bg-white p-3">
                      {src ? <img src={src} alt="کد QR رزرو" className="h-full w-full [image-rendering:pixelated]" /> : <div className="h-full w-full animate-pulse rounded-xl bg-muted" />}
                    </div>
                  ) : (
                    <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-2xl bg-muted/60">
                      <span className="text-xs text-muted-foreground">کد تحویل را به اپراتور بگویید</span>
                      <div dir="ltr" className="flex gap-1.5">
                        {code.split('').map((c, i) => <span key={i} className="grid h-12 w-8 place-items-center rounded-lg bg-card font-mono text-2xl font-extrabold shadow-[var(--shadow-sm)]">{c}</span>)}
                      </div>
                    </div>
                  )}
                  <button onClick={copy} className="mx-auto mt-4 flex items-center gap-2 rounded-full border px-4 py-2 text-sm">
                    {copied ? 'کپی شد' : 'کپی کد'}{copied ? <Check className="h-4 w-4 text-[hsl(var(--success))]" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                  </button>
                </div>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-white/70"><Sun className="h-3.5 w-3.5" />برای اسکن سریع، روشنایی صفحه را زیاد کنید</p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
