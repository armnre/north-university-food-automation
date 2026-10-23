import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/** اعلان نسخهٔ جدید PWA و وضعیت آفلاین شبکه. */
export default function PwaUpdatePrompt() {
  const [offline, setOffline] = useState(() => (typeof navigator !== 'undefined' ? !navigator.onLine : false));
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return (
    <>
      {offline && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-3 top-3 z-50 flex items-center gap-2.5 rounded-2xl border border-[hsl(var(--warning)/0.45)] bg-card/95 px-4 py-2.5 text-xs font-medium shadow-[var(--shadow-lg)] backdrop-blur sm:left-6 sm:right-auto sm:w-96"
        >
          <WifiOff className="h-4 w-4 shrink-0 text-[hsl(var(--warning))]" />
          <span className="flex-1">اتصال اینترنت قطع است؛ عملیات رزرو و پرداخت نیازمند اتصال شبکه است.</span>
        </div>
      )}

      {needRefresh && (
        <div
          role="alert"
          className="glass fixed inset-x-3 bottom-24 z-50 flex items-center gap-3 rounded-2xl border border-primary/30 p-3 shadow-[var(--shadow-xl)] sm:bottom-6 sm:left-6 sm:right-auto sm:w-96"
        >
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-bold">نسخه‌ی جدید سامانه آماده است</div>
            <div className="text-xs text-muted-foreground">برای دریافت آخرین بهبودها صفحه را به‌روزرسانی کنید.</div>
          </div>
          <button
            type="button"
            onClick={() => void updateServiceWorker(true)}
            className="flex min-h-11 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-xs font-bold text-primary-foreground"
          >
            <RefreshCw className="h-4 w-4" />
            به‌روزرسانی
          </button>
          <button
            type="button"
            onClick={() => setNeedRefresh(false)}
            aria-label="بستن اعلان به‌روزرسانی"
            className="grid h-11 w-11 place-items-center rounded-xl text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  );
}
