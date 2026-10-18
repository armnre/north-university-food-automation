import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { authLogout, authMe } from 'zitejs/api';

export type StudentMe = { id: string; studentNumber: string; fullName: string; faculty: string; major: string; degree: string; entryYear: number | null; nationalIdMasked: string };
export type StaffMe = { id: string; username: string; fullName: string; role: string; perms: string[] };
type Me = { kind: 'student'; student: StudentMe } | { kind: 'staff'; staff: StaffMe };

type Ctx = { token: string; me: Me | null; loading: boolean; signIn: (token: string) => Promise<void>; signOut: () => Promise<void> };
const SessionCtx = createContext<Ctx>(null as unknown as Ctx);
const KEY = 'shomal-dining-session';

/**
 * The opaque session token lives in sessionStorage (cleared when the tab closes). It carries no
 * credentials; the server stores only its SHA-256 and can revoke/expire it. See docs/SECURITY.md
 * for why HttpOnly cookies are not available inside the Zite runtime.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(KEY) ?? '');
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!token);

  const load = useCallback(async (t: string) => {
    if (!t) { setMe(null); setLoading(false); return; }
    setLoading(true);
    try {
      setMe((await authMe({ token: t })) as Me);
    } catch {
      sessionStorage.removeItem(KEY);
      setToken('');
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(token); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = async (t: string) => { sessionStorage.setItem(KEY, t); setToken(t); await load(t); };
  const signOut = async () => {
    const t = token;
    sessionStorage.removeItem(KEY);
    setToken(''); setMe(null);
    if (t) await authLogout({ token: t }).catch(() => undefined);
  };
  return <SessionCtx.Provider value={{ token, me, loading, signIn, signOut }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
