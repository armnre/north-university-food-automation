import { Routes, Route, Navigate } from 'react-router-dom';
import { Bell, CalendarDays, HelpCircle, Home, ReceiptText, UserRound, Wallet } from 'lucide-react';
import Shell, { type NavItem } from '../../components/Shell';
import type { StudentMe } from '../../lib/session';
import StudentDashboard from './StudentDashboard';
import MenuPage from './MenuPage';
import MyReservations from './MyReservations';
import WalletPage from './WalletPage';
import NotificationsPage from './NotificationsPage';
import ProfilePage from './ProfilePage';

const items: NavItem[] = [
  { to: '/', label: 'داشبورد', icon: <Home />, mobile: true },
  { to: '/menu', label: 'منوی غذا', icon: <CalendarDays />, mobile: true },
  { to: '/reservations', label: 'رزروهای من', icon: <ReceiptText />, mobile: true },
  { to: '/wallet', label: 'کیف پول', icon: <Wallet />, mobile: true },
  { to: '/notifications', label: 'اعلان‌ها', icon: <Bell /> },
  { to: '/profile', label: 'پروفایل', icon: <UserRound /> },
  { to: '/help', label: 'راهنما و پشتیبانی', icon: <HelpCircle /> },
];

export default function StudentApp({ me }: { me: StudentMe }) {
  return (
    <Shell items={items} userLabel={me.fullName || me.studentNumber} roleLabel={`دانشجو · ${me.studentNumber}`}>
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
