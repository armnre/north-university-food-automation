import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from 'react-error-boundary';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function RuntimeErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
  return (
    <div className="fixed inset-0 grid place-items-center p-4">
      <div className="relative w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-lg">
        <h3 className="mb-2 text-base font-semibold">خطا در نمایش صفحه</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          مشکلی در نمایش این صفحه پیش آمد. می‌توانید دوباره تلاش کنید یا به سامانه بازگردید.
        </p>
        <pre dir="ltr" className="mb-4 overflow-auto rounded border border-border bg-muted p-3 text-left font-mono text-xs text-muted-foreground">
          {error.message}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="rounded-xl border border-border bg-muted px-4 py-2 text-sm font-medium transition hover:bg-muted/70"
          >
            تلاش دوباره
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            بارگذاری مجدد
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallbackRender={(props) => <RuntimeErrorFallback error={props.error} resetErrorBoundary={props.resetErrorBoundary} />}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
