import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from "./App";
import { ErrorBoundary } from 'react-error-boundary';
import { HammerIcon, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { errMsg } from './lib/format';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

function reloadApp() {
  if (window._ziteOnReload) {
    window._ziteOnReload();
  } else {
    location.reload();
  }
}

function RuntimeErrorFallback(props: { error: Error }) {
  const allowAiFix = window.__ziteAllowAiFix === true;
  return (
    <div dir="rtl" className="fixed inset-0 grid place-items-center bg-background p-6 font-sans">
      <div className="w-full max-w-md rounded-3xl border bg-card p-6 text-center shadow-[var(--shadow-md)]">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-destructive/10 text-destructive"><AlertTriangle className="h-7 w-7" /></div>
        <h3 className="mb-2 text-lg font-bold">مشکلی در نمایش صفحه پیش آمد</h3>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">اطلاعات شما محفوظ است. صفحه را دوباره بارگذاری کنید؛ اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.</p>
        <div className="flex justify-center gap-2">
          <button type="button" onClick={reloadApp} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"><RefreshCw className="h-4 w-4" />بارگذاری دوباره</button>
          <button type="button" onClick={() => location.assign('/')} className="rounded-xl border px-4 py-2 text-sm">صفحه اصلی</button>
          {allowAiFix && <button type="button" onClick={() => window._ziteOnFixError?.(props.error)} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"><HammerIcon className="h-4 w-4" />رفع</button>}
        </div>
        <details className="mt-4 text-start text-xs text-muted-foreground"><summary className="cursor-pointer">جزئیات فنی</summary><pre dir="ltr" className="mt-2 overflow-auto rounded-lg bg-muted p-2">{props.error.message}</pre></details>
      </div>
    </div>
  );
}

// Any API error that a screen forgot to catch still reaches the user as a clean Persian toast.
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason as { status?: unknown } | undefined;
  if (r && typeof r === 'object' && 'status' in r) { ev.preventDefault(); toast.error(errMsg(r)); }
});
window.addEventListener('offline', () => toast.warning('اتصال اینترنت قطع شد', { id: 'net', description: 'تا برقراری دوباره اتصال، تغییرات ذخیره نمی‌شوند.', duration: Infinity }));
window.addEventListener('online', () => toast.success('اتصال اینترنت برقرار شد', { id: 'net', duration: 2500 }));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallbackRender={props => <RuntimeErrorFallback error={props.error} />}
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
