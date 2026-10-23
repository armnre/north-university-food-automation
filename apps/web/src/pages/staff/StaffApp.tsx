import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import {
  BarChart3,
  Bell,
  BookOpen,
  ChefHat,
  Building2,
  ClipboardList,
  FileSpreadsheet,
  LayoutDashboard,
  ScanLine,
  ScrollText,
  Settings,
  ShieldCheck,
  UsersRound,
  UtensilsCrossed,
  Wallet,
  GraduationCap,
} from 'lucide-react';
import Shell, { type NavItem } from '../../components/Shell';
import { LoadingBlock } from '../../components/ui-kit';
import { ROLES } from '../../lib/format';
import type { StaffMe } from '../../lib/session';

const AdminDashboard = lazy(() => import('./AdminDashboard'));
const StudentsPage = lazy(() => import('./StudentsPage'));
const ImportPage = lazy(() => import('./ImportPage'));
const UsersPage = lazy(() => import('./UsersPage'));
const CatalogPage = lazy(() => import('./CatalogPage'));
const OfferingsPage = lazy(() => import('./OfferingsPage'));
const ReservationsPage = lazy(() => import('./ReservationsPage'));
const DeliveryPage = lazy(() => import('./DeliveryPage'));
const FinancePage = lazy(() => import('./FinancePage'));
const ReportsPage = lazy(() => import('./ReportsPage'));
const AuditPage = lazy(() => import('./AuditPage'));
const SettingsPage = lazy(() => import('./SettingsPage'));
const NotifyPage = lazy(() => import('./NotifyPage'));
const FoodsPage = lazy(() => import('./FoodsPage'));
const KitchenDashboard = lazy(() => import('./KitchenDashboard'));

type Def = NavItem & { perms: string[]; el: React.ReactNode };

export default function StaffApp({ me }: { me: StaffMe }) {
  const defs: Def[] = [
    { to: '/', label: 'داشبورد', icon: <LayoutDashboard />, perms: ['dashboard'], el: <AdminDashboard />, mobile: true },
    {
      to: '/delivery',
      label: 'تحویل غذا (QR)',
      icon: <ScanLine />,
      perms: ['delivery', 'deliveryAll'],
      el: <DeliveryPage />,
      mobile: true,
    },
    {
      to: '/kitchen',
      label: 'داشبورد آشپزخانه',
      icon: <ChefHat />,
      perms: ['offerings'],
      el: <KitchenDashboard />,
      mobile: true,
    },
    {
      to: '/contractor',
      label: 'گزارش پیمانکار',
      icon: <BarChart3 />,
      perms: ['contractorReports'],
      el: <ReportsPage contractor />,
      mobile: true,
    },
    { to: '/students', label: 'دانشجویان', icon: <GraduationCap />, perms: ['students'], el: <StudentsPage />, mobile: true },
    { to: '/import', label: 'واردسازی Excel', icon: <FileSpreadsheet />, perms: ['import'], el: <ImportPage /> },
    { to: '/foods', label: 'کتابخانه‌ی غذا', icon: <BookOpen />, perms: ['foods'], el: <FoodsPage />, mobile: true },
    {
      to: '/offerings',
      label: 'منو، وعده و ظرفیت',
      icon: <UtensilsCrossed />,
      perms: ['offerings'],
      el: <OfferingsPage />,
      mobile: true,
    },
    { to: '/reservations', label: 'رزروها', icon: <ClipboardList />, perms: ['reservations'], el: <ReservationsPage /> },
    { to: '/catalog', label: 'سلف و پیمانکار', icon: <Building2 />, perms: ['catalog'], el: <CatalogPage /> },
    { to: '/finance', label: 'امور مالی', icon: <Wallet />, perms: ['finance'], el: <FinancePage />, mobile: true },
    { to: '/reports', label: 'گزارش‌ها', icon: <BarChart3 />, perms: ['reports'], el: <ReportsPage /> },
    { to: '/notify', label: 'اعلان‌ها', icon: <Bell />, perms: ['notify'], el: <NotifyPage /> },
    { to: '/users', label: 'کاربران و نقش‌ها', icon: <UsersRound />, perms: ['users', 'operators'], el: <UsersPage /> },
    { to: '/audit', label: 'رخدادهای ممیزی', icon: <ScrollText />, perms: ['audit'], el: <AuditPage /> },
    { to: '/settings', label: 'تنظیمات سیستم', icon: <Settings />, perms: ['settings'], el: <SettingsPage /> },
  ];
  const allowed = defs.filter((d) => d.perms.some((p) => me.perms.includes(p)));
  const home = allowed[0]?.to ?? '/';
  return (
    <Shell items={allowed} userLabel={me.fullName || me.username} roleLabel={ROLES[me.role] ?? me.role}>
      <Suspense fallback={<LoadingBlock rows={4} />}>
        <Routes>
          {allowed.map((d) => (
            <Route key={d.to} path={d.to} element={d.el} />
          ))}
          <Route path="*" element={allowed.length ? <Navigate to={home} replace /> : <NoAccess />} />
        </Routes>
      </Suspense>
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
