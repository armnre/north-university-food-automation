import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { authLogout, authMe, ApiError } from './api';

export type StudentMe = { id: string; studentNumber: string; fullName: string; faculty: string; major: string; degree: string; entryYear: number | null; nationalIdMasked: string };
export type StaffMe = { id: string; username: string; fullName: string; role: string; perms: string[] };
type Me = { kind: 'student'; student: StudentMe } | { kind: 'staff'; staff: StaffMe };
type Raw = Me | { kind: 'employee'; employee: { id: string; username: string; fullName: string; employeeKind: string; mustChangePassword: boolean } };

/** Employees use the same self-service screens as students (menu, wallet, reservations). */
function normalize(r: Raw): { me: Me; must: boolean } {
  if (r.kind === 'employee') {
    const e = r.employee;
    return { me: { kind: 'student', student: { id: e.id, studentNumber: e.username, fullName: e.fullName, faculty: '', major: '', degree: '', entryYear: null, nationalIdMasked: '' } }, must: e.mustChangePassword };
  }
  return { me: r, must: r.kind === 'staff' && !!(r.staff as StaffMe & { mustChangePassword?: boolean }).mustChangePassword };
}

type Ctx = { token: string; me: Me | null; loading: boolean; mustChangePassword: boolean; signIn: (token?: string) => Promise<void>; signOut: () => Promise<void> };
const SessionCtx = createContext<Ctx>(null as unknown as Ctx);

/**
 * The session lives in an HttpOnly, Secure, SameSite cookie set by the API — JavaScript never sees it.
 * token is a constant marker so pages that still pass it keep working; the adapter drops it.
 */
const TOKEN = 'cookie';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMust] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const n = normalize((await authMe()) as Raw);
      setMe(n.me);
      setMust(n.must);
    } catch (e) {
      setMe(null);
      setMust(e instanceof ApiError && e.code === 'PASSWORD_CHANGE_REQUIRED');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const expired = () => setMe(null);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, [load]);

  const signIn = async () => { await load(); };
  const signOut = async () => {
    setMe(null); setMust(false);
    await authLogout().catch(() => undefined);
  };
  return <SessionCtx.Provider value={{ token: TOKEN, me, loading, mustChangePassword, signIn, signOut }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
