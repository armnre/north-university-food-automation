import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { Bell, CalendarDays, HelpCircle, Home, ReceiptText, UserRound, Wallet } from 'lucide-react';
import { studentNotifications } from '../../lib/api';
import Shell, { type NavItem } from '../../components/Shell';
import type { StudentMe } from '../../lib/session';
import StudentDashboard from './StudentDashboard';
import MenuPage from './MenuPage';
import MyReservations from './MyReservations';
import WalletPage from './WalletPage';
import NotificationsPage from './NotificationsPage';
import ProfilePage from './ProfilePage';

const items: NavItem[] = [
  { to: '/', label: 'خانه', icon: <Home />, mobile: true },
  { to: '/menu', label: 'منوی غذا', icon: <CalendarDays />, mobile: true },
  { to: '/reservations', label: 'رزروها', icon: <ReceiptText />, mobile: true },
  { to: '/wallet', label: 'کیف پول', icon: <Wallet />, mobile: true },
  { to: '/profile', label: 'پروفایل', icon: <UserRound />, mobile: true },
  { to: '/notifications', label: 'اعلان‌ها', icon: <Bell /> },
  { to: '/help', label: 'راهنما و پشتیبانی', icon: <HelpCircle /> },
];

function NotificationBell() {
  
  const loc = useLocation();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const seen = localStorage.getItem('notif-seen') ?? '';
    if (loc.pathname === '/notifications') { localStorage.setItem('notif-seen', new Date().toISOString()); setUnread(0); return; }
    studentNotifications().then((raw) => {
      const r = raw as unknown as { notifications: { createdAt: string }[] };
      setUnread(r.notifications.filter((n) => !seen || new Date(n.createdAt) > new Date(seen)).length);
    }).catch(() => undefined);
  }, [loc.pathname]);
  return (
    <Link to="/notifications" aria-label="اعلان‌ها" className="relative grid h-10 w-10 place-items-center rounded-xl border bg-card shadow-[var(--shadow-sm)] transition active:scale-95">
      <Bell className={unread ? 'h-5 w-5 origin-top animate-[wiggle_1.2s_ease-in-out_2]' : 'h-5 w-5'} />
      {unread > 0 && <span className="absolute -left-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground ring-2 ring-background">{unread > 9 ? '۹+' : unread.toLocaleString('fa-IR')}</span>}
    </Link>
  );
}

export default function StudentApp({ me }: { me: StudentMe }) {
  return (
    <Shell items={items} userLabel={me.fullName || me.studentNumber} roleLabel={`دانشجو · ${me.studentNumber}`} headerActions={<NotificationBell />}>
      <Routes>
        <Route path="/" element={<StudentDashboard me={me} />} />
        <Route path="/menu" element={<MenuPage />} />
        <Route path="/reservations" element={<MyReservations />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/notifications" element={<NotificationsPage mode="notifications" />} />
        <Route path="/help" element={<NotificationsPage mode="help" />} />
        <Route path="/profile" element={<ProfilePage me={me} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
