import { BrowserRouter } from 'react-router-dom';
import { useEffect } from 'react';
import { Toaster } from '@project/components/ui/sonner';
import { SessionProvider, useSession } from './lib/session';
import LoginPage from './pages/LoginPage';
import StudentApp from './pages/student/StudentApp';
import StaffApp from './pages/staff/StaffApp';
import { LoadingBlock } from './components/ui-kit';

function Gate() {
  const { me, loading } = useSession();
  if (loading) return <div className="mx-auto max-w-md p-10"><LoadingBlock rows={3} /></div>;
  if (!me) return <LoginPage />;
  return me.kind === 'student' ? <StudentApp me={me.student} /> : <StaffApp me={me.staff} />;
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
      <Toaster position="top-center" richColors dir="rtl" />
    </div>
  );
}
