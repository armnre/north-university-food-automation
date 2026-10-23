import { BrowserRouter } from 'react-router-dom';
import { useEffect } from 'react';
import { Toaster } from '@project/components/ui/sonner';
import { SessionProvider, useSession, type EmployeeMe, type StudentMe } from './lib/session';
import LoginPage from './pages/LoginPage';
import StudentApp from './pages/student/StudentApp';
import StaffApp from './pages/staff/StaffApp';
import { LoadingBlock } from './components/ui-kit';

/** کارمند/هیئت‌علمی همان UI دانشجو را دارد (با شناسهٔ نام کاربری به‌جای شمارهٔ دانشجویی). */
function employeeAsStudent(e: EmployeeMe): StudentMe {
  return {
    id: e.id,
    studentNumber: e.username,
    fullName: e.fullName,
    faculty: e.department,
    major: '',
    degree: '',
    entryYear: null,
    nationalIdMasked: '—',
    status: e.status,
    balanceRial: e.balanceRial,
    customerGroup: 'Student',
  };
}

function Gate() {
  const { me, loading } = useSession();
  if (loading) return <div className="mx-auto max-w-md p-10"><LoadingBlock rows={3} /></div>;
  if (!me) return <LoginPage />;
  if (me.kind === 'staff') return <StaffApp me={me.staff} />;
  if (me.kind === 'employee') return <StudentApp me={employeeAsStudent(me.employee)} />;
  return <StudentApp me={me.student} />;
}

export default function App() {
  useEffect(() => {
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'fa';
    document.title = 'سامانه اتوماسیون تغذیه دانشگاه شمال';
  }, []);
  return (
    <div dir="rtl" className="font-sans">
      <SessionProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </SessionProvider>
      <Toaster
        position="top-center"
        dir="rtl"
        closeButton
        gap={10}
        offset={16}
        toastOptions={{
          duration: 4500,
          classNames: {
            toast: 'group !w-[calc(100vw-2rem)] sm:!w-[380px] !max-w-[calc(100vw-2rem)] !rounded-2xl !border !border-border/70 !bg-card/95 !backdrop-blur-xl !shadow-[0_12px_40px_-12px_hsl(var(--foreground)/0.25)] !px-4 !py-3 !gap-3 font-sans',
            title: '!text-sm !font-semibold !leading-6 break-words',
            description: '!text-xs !text-muted-foreground break-words',
            icon: '!m-0',
            error: '!border-destructive/30 [&_[data-icon]]:!text-destructive !bg-gradient-to-l !from-destructive/10 !to-card',
            success: '!border-[hsl(var(--success)/0.35)] [&_[data-icon]]:!text-[hsl(var(--success))] !bg-gradient-to-l !from-[hsl(var(--success)/0.10)] !to-card',
            warning: '[&_[data-icon]]:!text-[hsl(var(--warning))]',
            closeButton: '!bg-card !border-border',
          },
        }}
      />
    </div>
  );
}
