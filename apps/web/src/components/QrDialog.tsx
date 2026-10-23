import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, MapPin, Sun, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@project/components/ui/dialog';
import { cn } from '@project/components/lib/utils';
import { MEALS, faDate } from '../lib/format';

export type QrTarget = {
  qrToken: string;
  code: string;
  foodName: string;
  mealSlot: string;
  serviceDate: string;
  cafeteriaName: string;
};

/** بلیط تحویل غذا: نمایش تمام‌صفحهٔ QR به همراه کد ۸ کاراکتری درشت (بدون پیشوند R-). */
export default function QrDialog({ target, onClose }: { target: QrTarget | null; onClose: () => void }) {
  const [src, setSrc] = useState('');
  const [mode, setMode] = useState<'qr' | 'code'>('qr');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!target) return;
    setMode('qr');
    setSrc('');
    void QRCode.toDataURL(target.qrToken, { width: 560, margin: 1, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [target]);

  const code = (target?.code ?? '').replace(/^R-/i, '').toUpperCase();

  const copy = async () => {
    if (!code) return;
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="h-[100dvh] max-h-[100dvh] max-w-full overflow-y-auto rounded-none border-0 bg-[hsl(var(--sidebar-background))] p-0 sm:h-auto sm:max-w-sm sm:rounded-[2rem] [&>button]:hidden"
      >
        <DialogTitle className="sr-only">بلیط تحویل غذا</DialogTitle>
        <DialogDescription className="sr-only">نمایش کد QR و کد ۸ کاراکتری تحویل غذا</DialogDescription>
        {target && (
          <div className="flex min-h-full flex-col px-5 pb-safe pt-5">
            <div className="flex items-center justify-between text-white">
              <span className="text-sm font-semibold text-white/85">بلیط تحویل غذا</span>
              <button
                onClick={onClose}
                aria-label="بستن بلیط"
                className="grid h-11 w-11 place-items-center rounded-full bg-white/10 transition hover:bg-white/20"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="my-auto py-4">
              <div className="animate-in zoom-in-95 overflow-hidden rounded-[1.75rem] bg-card shadow-[var(--shadow-xl)]">
                <div className="hero-surface px-5 pb-5 pt-4 text-white">
                  <div className="text-xs text-white/75">
                    {MEALS[target.mealSlot]} · {faDate(target.serviceDate)}
                  </div>
                  <div className="mt-1 text-2xl font-extrabold">{target.foodName}</div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-white/80">
                    <MapPin className="h-3.5 w-3.5" />
                    {target.cafeteriaName}
                  </div>
                </div>
                <div className="relative h-0 border-t-2 border-dashed border-border">
                  <span className="absolute -right-3 -top-3 h-6 w-6 rounded-full bg-[hsl(var(--sidebar-background))]" />
                  <span className="absolute -left-3 -top-3 h-6 w-6 rounded-full bg-[hsl(var(--sidebar-background))]" />
                </div>
                <div className="p-5">
                  <div className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-muted p-1">
                    {(['qr', 'code'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setMode(m)}
                        className={cn(
                          'min-h-11 rounded-xl text-sm font-semibold transition',
                          mode === m ? 'bg-card shadow-[var(--shadow-sm)]' : 'text-muted-foreground',
                        )}
                      >
                        {m === 'qr' ? 'اسکن کیو‌آر' : 'کد ۸ کاراکتری'}
                      </button>
                    ))}
                  </div>

                  {mode === 'qr' ? (
                    <div className="space-y-3">
                      <div className="mx-auto aspect-square w-full max-w-[264px] rounded-2xl border bg-white p-3">
                        {src ? (
                          <img src={src} alt="کد QR رزرو غذا" className="h-full w-full [image-rendering:pixelated]" />
                        ) : (
                          <div className="h-full w-full animate-pulse rounded-xl bg-muted" />
                        )}
                      </div>
                      <div className="rounded-xl bg-muted/65 px-3 py-2 text-center">
                        <div className="text-[11px] text-muted-foreground">کد تحویل دستی (بدون پیشوند)</div>
                        <div dir="ltr" className="mt-0.5 font-mono text-2xl font-extrabold tracking-[0.22em]">
                          {code}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-2xl bg-muted/60 px-2">
                      <span className="text-xs text-muted-foreground">کد ۸ کاراکتری را به اپراتور سلف اعلام کنید</span>
                      <div dir="ltr" className="flex flex-wrap justify-center gap-1.5">
                        {code.split('').map((c, i) => (
                          <span
                            key={i}
                            className="grid h-12 w-8 place-items-center rounded-lg bg-card font-mono text-2xl font-extrabold shadow-[var(--shadow-sm)]"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => void copy()}
                    className="mx-auto mt-4 flex min-h-11 items-center gap-2 rounded-full border px-5 py-2 text-sm font-medium transition hover:bg-muted/60"
                  >
                    {copied ? 'کد کپی شد' : 'کپی کد ۸ کاراکتری'}
                    {copied ? (
                      <Check className="h-4 w-4 text-[hsl(var(--success))]" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-white/80">
                <Sun className="h-3.5 w-3.5" />
                برای اسکن سریع‌تر در سلف، روشنایی صفحه را افزایش دهید
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
