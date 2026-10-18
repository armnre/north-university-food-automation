import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LogOut, Menu as MenuIcon, X } from 'lucide-react';
import { Button } from '@project/components/ui/button';
import { cn } from '@project/components/lib/utils';
import { Emblem } from './ui-kit';
import { useSession } from '../lib/session';

export type NavItem = { to: string; label: string; icon: ReactNode; mobile?: boolean };

function Brand({ light }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Emblem />
      <div className="leading-tight">
        <div className={cn('text-[15px] font-bold', light && 'text-white')}>دانشگاه شمال</div>
        <div className={cn('text-xs', light ? 'text-[hsl(var(--sidebar-foreground))]' : 'text-muted-foreground')}>سامانه اتوماسیون تغذیه</div>
      </div>
    </div>
  );
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="space-y-1" aria-label="منوی اصلی">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--sidebar-ring))]',
              isActive ? 'bg-[hsl(var(--sidebar-accent))] font-semibold text-white' : 'text-[hsl(var(--sidebar-foreground))] hover:bg-[hsl(var(--sidebar-accent)/0.6)] hover:text-white',
            )
          }
        >
          {({ isActive }) => (
            <>
              <span className={cn('[&>svg]:h-[18px] [&>svg]:w-[18px]', isActive && 'text-[hsl(var(--sidebar-primary))]')}>{it.icon}</span>
              {it.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export default function Shell({ items, userLabel, roleLabel, children }: { items: NavItem[]; userLabel: string; roleLabel: string; children: ReactNode }) {
  const { signOut } = useSession();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const current = items.find((i) => (i.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(i.to)));
  const mobileItems = items.filter((i) => i.mobile).slice(0, 4);

  const sidebar = (
    <div className="flex h-full flex-col bg-[hsl(var(--sidebar-background))] p-4">
      <div className="mb-6 px-1"><Brand light /></div>
      <div className="flex-1 overflow-y-auto"><NavList items={items} onNavigate={() => setOpen(false)} /></div>
      <div className="mt-4 rounded-lg border border-[hsl(var(--sidebar-border))] p-3">
        <div className="truncate text-sm font-medium text-white">{userLabel}</div>
        <div className="text-xs text-[hsl(var(--sidebar-foreground))]">{roleLabel}</div>
        <button onClick={signOut} className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[hsl(var(--sidebar-foreground))] hover:bg-[hsl(var(--sidebar-accent))] hover:text-white">
          <LogOut className="h-4 w-4" /> خروج از حساب
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 right-0 z-30 hidden w-64 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal>
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-72 shadow-xl">{sidebar}</div>
        </div>
      )}
      <div className="lg:pr-64">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background/85 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-2 text-sm">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)} aria-label="باز کردن منو">
              {open ? <X /> : <MenuIcon />}
            </Button>
            <span className="hidden text-muted-foreground sm:inline">سامانه تغذیه</span>
            <span className="hidden text-muted-foreground sm:inline">/</span>
            <span className="font-medium">{current?.label ?? ''}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden text-left leading-tight sm:block">
              <div className="text-xs font-medium">{userLabel}</div>
              <div className="text-[11px] text-muted-foreground">{roleLabel}</div>
            </div>
            <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-primary to-[hsl(var(--chart-3))] text-sm font-bold text-primary-foreground shadow-sm">{userLabel.trim().charAt(0) || '؟'}</div>
          </div>
        </header>
        <main key={loc.pathname} className={cn('page-enter mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8', mobileItems.length && 'pb-28 lg:pb-8')}>{children}</main>
      </div>
      {mobileItems.length > 0 && (
        <nav className="fixed inset-x-3 bottom-3 z-30 grid rounded-2xl border bg-card/90 p-1.5 shadow-[var(--shadow-xl)] backdrop-blur-xl lg:hidden" style={{ gridTemplateColumns: `repeat(${mobileItems.length}, 1fr)`, marginBottom: 'env(safe-area-inset-bottom)' }} aria-label="دسترسی سریع">
          {mobileItems.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.to === '/'} className={({ isActive }) => cn('flex flex-col items-center gap-1 rounded-xl py-2 text-[11px] transition-all duration-200 active:scale-95', isActive ? 'bg-primary text-primary-foreground font-semibold shadow-sm' : 'text-muted-foreground')}>
              <span className="[&>svg]:h-5 [&>svg]:w-5">{it.icon}</span>
              {it.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
