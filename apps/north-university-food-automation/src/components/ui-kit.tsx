import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import { Button } from '@project/components/ui/button';
import { Skeleton } from '@project/components/ui/skeleton';
import { cn } from '@project/components/lib/utils';
import type { Tone } from '../lib/format';

/** App logo (generated). */
export function Emblem({ className }: { className?: string }) {
  return <img src="https://images.fillout.com/897142/thgnrgdvdc/generated-images/csmL29ZvYgCZwXYUTkJPuL/img_ikYUIdBmTklcxgXy.jpg" alt="لوگوی سامانه تغذیه" className={cn('h-9 w-9 rounded-[11px] object-cover shadow-sm', className)} />;
}

const toneCls: Record<Tone, string> = {
  info: 'bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))] border-[hsl(var(--info)/0.25)]',
  success: 'bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.25)]',
  warning: 'bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.3)]',
  danger: 'bg-destructive/10 text-destructive border-destructive/25',
  muted: 'bg-muted text-muted-foreground border-border',
};
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', toneCls[tone])}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[1.6rem] font-extrabold leading-tight tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint, icon, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'default' | 'primary' }) {
  return (
    <div className={cn('lift relative overflow-hidden rounded-2xl border p-4 shadow-[var(--shadow-sm)] sm:p-5', tone === 'primary' ? 'hero-surface border-transparent text-primary-foreground shadow-[var(--shadow-md)]' : 'bg-card')}>
      {tone === 'primary' && <div className="dot-grid pointer-events-none absolute inset-0 opacity-50" />}
      <div className="relative flex items-center justify-between">
        <span className={cn('text-sm', tone === 'primary' ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{label}</span>
        {icon && <span className={cn('grid h-9 w-9 place-items-center rounded-xl', tone === 'primary' ? 'bg-white/10 text-[hsl(var(--sidebar-primary))]' : 'bg-primary/10 text-primary')}>{icon}</span>}
      </div>
      <div className="num relative mt-2 text-2xl font-extrabold tracking-tight sm:text-[1.7rem]">{value}</div>
      {hint && <div className={cn('relative mt-1 text-xs', tone === 'primary' ? 'text-primary-foreground/75' : 'text-muted-foreground')}>{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card/60 px-6 py-10 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary"><Inbox className="h-7 w-7" /></span>
      <p className="mt-3 font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
      <AlertTriangle className="h-9 w-9 text-destructive" />
      <p className="mt-3 font-medium">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="ms-1 h-4 w-4" /> تلاش دوباره
        </Button>
      )}
    </div>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy>
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
    </div>
  );
}

export function Section({ title, children, actions, className }: { title?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-border/70 bg-card p-4 shadow-[var(--shadow-sm)] sm:p-5', className)}>
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-2">
          {title && <h2 className="font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** Inline, animated error banner that wraps gracefully on any screen width. */
export function ErrorNote({ message, onClose }: { message: string; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="animate-in fade-in slide-in-from-top-1 flex w-full min-w-0 items-start gap-3 rounded-xl border border-destructive/25 bg-gradient-to-l from-destructive/10 to-destructive/[0.03] p-3 text-sm shadow-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive"><AlertTriangle className="h-4 w-4" /></span>
      <p className="min-w-0 flex-1 break-words pt-1 leading-6 text-foreground">{message}</p>
      {onClose && <button type="button" onClick={onClose} aria-label="بستن" className="shrink-0 rounded-md px-1.5 py-1 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive">✕</button>}
    </div>
  );
}
