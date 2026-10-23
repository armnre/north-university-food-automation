import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { authLogout, authMe, UNAUTHORIZED_EVENT, type EmployeeMe, type Me, type StaffMe, type StudentMe } from './api';

type Ctx = {
  me: Me | null;
  loading: boolean;
  /** بازخوانی پروفایل از `/auth/me` (پس از ورود یا تغییر وضعیت). */
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionCtx = createContext<Ctx>(null as unknown as Ctx);

/**
 * نشست با کوکی `HttpOnly` مدیریت می‌شود؛ هیچ توکنی در حافظهٔ مرورگر
 * (`sessionStorage`/`localStorage`) نگهداری نمی‌شود.
 * پروفایل کاربر از `GET /api/v1/auth/me` خوانده می‌شود.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await authMe());
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // هر ۴۰۱ از هر درخواست ⇒ خروج از نشست
  useEffect(() => {
    const onUnauthorized = () => {
      setMe(null);
      setLoading(false);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signIn = refresh;

  const signOut = useCallback(async () => {
    setMe(null);
    try {
      await authLogout();
    } catch {
      /* خروج سمت سرور انجام نشد؛ کوکی در مرورگر پاک می‌شود */
    }
  }, []);

  return <SessionCtx.Provider value={{ me, loading, refresh, signIn, signOut }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
export type { Me, StudentMe, EmployeeMe, StaffMe };
