import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { errMsg } from './format';
import { useSession } from './session';

/**
 * بارگذاری داده از API.
 * نشست در کوکی HttpOnly است، بنابراین دیگر توکنی به تابع بارگذاری داده نمی‌شود.
 * در خطای ۴۰۱ کاربر از نشست خارج می‌شود.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const { signOut } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fnRef.current());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await signOut();
        return;
      }
      const message = errMsg(e);
      if (/نشست/.test(message)) {
        await signOut();
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [signOut, ...deps]);
  // یادداشت: `deps` توسط فراخوان‌کننده تعیین می‌شود تا بارگذاری مجدد کنترل شود.

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}
