import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { LogOut, Menu as MenuIcon, X } from 'lucide-react';
import { cn } from '@project/components/lib/utils';
import { Emblem } from './ui-kit';
import { useSession } from '../lib/session';
import InstallPrompt from './InstallPrompt';

export type NavItem = { to: string; label: string; icon: ReactNode; mobile?: boolean };

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <Emblem />
      <div className="leading-tight">
        <div className="text-[15px] font-bold text-white">دانشگاه شمال</div>
        <div className="text-xs text-[hsl(var(--sidebar-foreground))]">سامانه اتوماسیون تغذیه</div>
      </div>
    </div>
  );
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="space-y-1" aria-label="منوی اصلی">
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.to === '/'} onClick={onNavigate}
          className={({ isActive }) => cn(
            'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--sidebar-ring))]',
            isActive ? 'font-semibold text-white' : 'text-[hsl(var(--sidebar-foreground))] hover:bg-[hsl(var(--sidebar-accent)/0.6)] hover:text-white',
          )}>
          {({ isActive }) => (
            <>
              {isActive && <motion.span layoutId="side-active" className="absolute inset-0 rounded-xl bg-[hsl(var(--sidebar-accent))] ring-1 ring-white/5" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <span className={cn('relative [&>svg]:h-[18px] [&>svg]:w-[18px]', isActive && 'text-[hsl(var(--sidebar-primary))]')}>{it.icon}</span>
              <span className="relative">{it.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function Sidebar({ items, userLabel, roleLabel, onNavigate }: { items: NavItem[]; userLabel: string; roleLabel: string; onNavigate?: () => void }) {
  const { signOut } = useSession();
  return (
    <div className="hero-surface relative flex h-full flex-col overflow-hidden p-4">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative mb-6 px-1 pt-1"><Brand /></div>
      <div className="relative flex-1 overflow-y-auto"><NavList items={items} onNavigate={onNavigate} /></div>
      <div className="relative mt-4 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <Avatar label={userLabel} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-white">{userLabel}</div>
            <div className="text-xs text-[hsl(var(--sidebar-foreground))]">{roleLabel}</div>
          </div>
        </div>
        <button onClick={signOut} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white/5 px-2 py-2 text-sm text-[hsl(var(--sidebar-foreground))] transition hover:bg-white/10 hover:text-white">
          <LogOut className="h-4 w-4" /> خروج از حساب
        </button>
      </div>
    </div>
  );
}

function Avatar({ label }: { label: string }) {
  return <img src="https://images.fillout.com/897142/thgnrgdvdc/generated-images/jGfdk2ejTg5howczPkJJS2/img_37WK_4K4vjO6EpYg.jpg" alt={label} className="h-10 w-10 shrink-0 rounded-full object-cover shadow-sm ring-2 ring-[hsl(var(--sidebar-primary)/0.6)]" />;
}

function BottomNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="glass fixed inset-x-3 bottom-3 z-30 grid rounded-[1.4rem] border border-border/70 p-1.5 shadow-[var(--shadow-xl)] lg:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)`, marginBottom: 'env(safe-area-inset-bottom)' }} aria-label="دسترسی سریع">
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.to === '/'} className="relative flex flex-col items-center gap-0.5 rounded-2xl py-2 text-[11px] active:scale-95 transition-transform">
          {({ isActive }) => (
            <>
              {isActive && <motion.span layoutId="bottom-active" className="absolute inset-0 rounded-2xl bg-primary shadow-[0_8px_20px_-8px_hsl(var(--primary)/0.7)]" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
              <span className={cn('relative transition-transform [&>svg]:h-5 [&>svg]:w-5', isActive ? 'text-primary-foreground -translate-y-px' : 'text-muted-foreground')}>{it.icon}</span>
              <span className={cn('relative', isActive ? 'font-semibold text-primary-foreground' : 'text-muted-foreground')}>{it.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export default function Shell({ items, userLabel, roleLabel, headerActions, children }: { items: NavItem[]; userLabel: string; roleLabel: string; headerActions?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const current = items.find((i) => (i.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(i.to)));
  const mobileItems = items.filter((i) => i.mobile).slice(0, 5);

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 right-0 z-30 hidden w-64 lg:block"><Sidebar items={items} userLabel={userLabel} roleLabel={roleLabel} /></aside>
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal>
            <motion.div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} />
            <motion.div className="absolute inset-y-0 right-0 w-[82%] max-w-xs overflow-hidden rounded-l-3xl shadow-2xl"
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}>
              <Sidebar items={items} userLabel={userLabel} roleLabel={roleLabel} onNavigate={() => setOpen(false)} />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <div className="lg:pr-64">
        <header className="glass sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/60 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button className="grid h-10 w-10 place-items-center rounded-xl border bg-card shadow-[var(--shadow-sm)] active:scale-95 lg:hidden" onClick={() => setOpen(true)} aria-label="باز کردن منو">
              {open ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
            </button>
            <div className="min-w-0 leading-tight">
              <div className="hidden text-[11px] text-muted-foreground sm:block lg:block">سامانه تغذیه</div>
              <div className="truncate text-base font-bold">{current?.label ?? ''}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {headerActions}
            <div className="hidden text-left leading-tight sm:block">
              <div className="text-xs font-medium">{userLabel}</div>
              <div className="text-[11px] text-muted-foreground">{roleLabel}</div>
            </div>
            <Avatar label={userLabel} />
          </div>
        </header>
        <main key={loc.pathname} className={cn('page-enter mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:py-8', mobileItems.length && 'pb-32 lg:pb-8')}>{children}</main>
      </div>
      {mobileItems.length > 0 && <BottomNav items={mobileItems} />}
      <InstallPrompt />
    </div>
  );
}
