import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { Emblem } from './ui-kit';

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export default function InstallPrompt() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [show, setShow] = useState(false);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    if (isStandalone() || localStorage.getItem('pwa-dismissed')) return;
    const h = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); setShow(true); };
    window.addEventListener('beforeinstallprompt', h);
    const t = ios ? setTimeout(() => setShow(true), 2500) : undefined;
    return () => { window.removeEventListener('beforeinstallprompt', h); if (t) clearTimeout(t); };
  }, [ios]);

  if (!show) return null;
  const dismiss = () => { localStorage.setItem('pwa-dismissed', '1'); setShow(false); };
  const install = async () => { if (!evt) return; await evt.prompt(); await evt.userChoice; dismiss(); };

  return (
    <div className="glass animate-in slide-in-from-top-4 fixed inset-x-3 top-3 z-50 flex items-center gap-3 rounded-2xl border p-3 shadow-[var(--shadow-xl)] sm:left-auto sm:right-6 sm:w-96">
      <Emblem className="h-11 w-11" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold">نصب اپلیکیشن تغذیه</div>
        <div className="text-xs text-muted-foreground">
          {ios ? <>دکمه <Share className="inline h-3.5 w-3.5" /> را بزنید و «Add to Home Screen» را انتخاب کنید.</> : 'برای دسترسی سریع، روی صفحه‌ی اصلی نصب کنید.'}
        </div>
      </div>
      {evt && <button onClick={install} className="flex h-9 items-center gap-1 rounded-xl bg-primary px-3 text-xs font-bold text-primary-foreground"><Download className="h-4 w-4" />نصب</button>}
      <button onClick={dismiss} aria-label="بستن" className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
    </div>
  );
}
