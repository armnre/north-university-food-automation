import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg } from './format';
import { useSession } from './session';

/** Loads data with a session token; signs out on an expired session. */
export function useLoad<T>(fn: (token: string) => Promise<T>, deps: unknown[] = []) {
  const { token, signOut } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fnRef.current(token));
    } catch (e) {
      const m = errMsg(e);
      if (/نشست/.test(m)) { await signOut(); return; }
      setError(m);
    } finally {
      setLoading(false);
    }
  }, [token, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
