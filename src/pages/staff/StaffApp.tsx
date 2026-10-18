import { Routes, Route, Navigate } from 'react-router-dom';
import { BarChart3, Bell, BookOpen, ChefHat, Building2, ClipboardList, FileSpreadsheet, LayoutDashboard, ScanLine, ScrollText, Settings, ShieldCheck, UsersRound, UtensilsCrossed, Wallet, GraduationCap } from 'lucide-react';
import Shell, { type NavItem } from '../../components/Shell';
import { ROLES } from '../../lib/format';
import type { StaffMe } from '../../lib/session';
import AdminDashboard from './AdminDashboard';
import StudentsPage from './StudentsPage';
import ImportPage from './ImportPage';
import UsersPage from './UsersPage';
import CatalogPage from './CatalogPage';
import OfferingsPage from './OfferingsPage';
import ReservationsPage from './ReservationsPage';
import DeliveryPage from './DeliveryPage';
import FinancePage from './FinancePage';
import ReportsPage from './ReportsPage';
import AuditPage from './AuditPage';
import SettingsPage from './SettingsPage';
import NotifyPage from './NotifyPage';
import FoodsPage from './FoodsPage';
import KitchenDashboard from './KitchenDashboard';

type Def = NavItem & { perm: string; el: React.ReactNode };

export default function StaffApp({ me }: { me: StaffMe }) {
  const defs: Def[] = [
    { to: '/', label: 'داشبورد', icon: <LayoutDashboard />, perm: 'dashboard', el: <AdminDashboard />, mobile: true },
    { to: '/delivery', label: 'تحویل غذا (QR)', icon: <ScanLine />, perm: 'delivery', el: <DeliveryPage />, mobile: true },
    { to: '/kitchen', label: 'داشبورد آشپزخانه', icon: <ChefHat />, perm: 'menu', el: <KitchenDashboard />, mobile: true },
    { to: '/contractor', label: 'گزارش پیمانکار', icon: <BarChart3 />, perm: 'contractor', el: <ReportsPage contractor />, mobile: true },
    { to: '/students', label: 'دانشجویان', icon: <GraduationCap />, perm: 'students', el: <StudentsPage />, mobile: true },
    { to: '/import', label: 'واردسازی Excel', icon: <FileSpreadsheet />, perm: 'import', el: <ImportPage /> },
    { to: '/foods', label: 'کتابخانه‌ی غذا', icon: <BookOpen />, perm: 'foods', el: <FoodsPage />, mobile: true },
    { to: '/offerings', label: 'منو، وعده و ظرفیت', icon: <UtensilsCrossed />, perm: 'menu', el: <OfferingsPage />, mobile: true },
    { to: '/reservations', label: 'رزروها', icon: <ClipboardList />, perm: 'reservations', el: <ReservationsPage /> },
    { to: '/catalog', label: 'سلف و پیمانکار', icon: <Building2 />, perm: 'catalog', el: <CatalogPage /> },
    { to: '/finance', label: 'امور مالی', icon: <Wallet />, perm: 'finance', el: <FinancePage />, mobile: true },
    { to: '/reports', label: 'گزارش‌ها', icon: <BarChart3 />, perm: 'reports', el: <ReportsPage /> },
    { to: '/notify', label: 'اعلان‌ها', icon: <Bell />, perm: 'notify', el: <NotifyPage /> },
    { to: '/users', label: 'کاربران و نقش‌ها', icon: <UsersRound />, perm: 'users', el: <UsersPage /> },
    { to: '/audit', label: 'رخدادهای ممیزی', icon: <ScrollText />, perm: 'audit', el: <AuditPage /> },
    { to: '/settings', label: 'تنظیمات سیستم', icon: <Settings />, perm: 'settings', el: <SettingsPage /> },
  ];
  const allowed = defs.filter((d) => me.perms.includes(d.perm));
  const home = allowed[0]?.to ?? '/';
  return (
    <Shell items={allowed} userLabel={me.fullName || me.username} roleLabel={ROLES[me.role] ?? me.role}>
      <Routes>
        {allowed.map((d) => <Route key={d.to} path={d.to} element={d.el} />)}
        <Route path="*" element={allowed.length ? <Navigate to={home} replace /> : <NoAccess />} />
      </Routes>
    </Shell>
  );
}

function NoAccess() {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <ShieldCheck className="h-12 w-12 text-muted-foreground" />
      <p className="mt-3 font-semibold">دسترسی به این بخش مجاز نیست</p>
    </div>
  );
}
