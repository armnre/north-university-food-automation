import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { toast } from 'sonner';
import { ApiError, authChangePassword } from '../lib/api';
import { errMsg } from '../lib/format';
import { ErrorNote, Emblem } from './ui-kit';
import { useSession } from '../lib/session';

export type Captcha = { captchaId: string; svg: string } | null;

/** Pulls a server-issued captcha out of a failed login (428 CAPTCHA_REQUIRED or 401 after repeated tries). */
export const captchaFrom = (e: unknown): Captcha => (e instanceof ApiError && e.details?.captcha ? e.details.captcha : null);

export function CaptchaBox({ captcha, answer, onAnswer }: { captcha: NonNullable<Captcha>; answer: string; onAnswer: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="captcha">کد امنیتی</Label>
      <div className="flex items-center gap-2">
        {/* SVG is generated server-side from digits only (no user input) */}
        <div className="h-12 shrink-0 overflow-hidden rounded-xl border bg-card px-2 [&>svg]:h-full [&>svg]:w-auto" dangerouslySetInnerHTML={{ __html: captcha.svg }} />
        <Input id="captcha" inputMode="numeric" dir="ltr" autoComplete="off" className="h-12 rounded-xl bg-card text-base" value={answer} onChange={(e) => onAnswer(e.target.value)} placeholder="پاسخ" />
      </div>
    </div>
  );
}

export function ChangePasswordScreen() {
  const { signIn, signOut } = useSession();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const mismatch = !!f.confirm && f.next !== f.confirm;
  const valid = !!f.current && f.next.length >= 10 && f.next === f.confirm;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setErr('');
    try {
      await authChangePassword({ currentPassword: f.current, newPassword: f.next });
      toast.success('رمز عبور تغییر کرد.');
      await signIn();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  };
  const labels = { current: 'رمز فعلی', next: 'رمز جدید (حداقل ۱۰ نویسه)', confirm: 'تکرار رمز جدید' };
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl border bg-card p-6 shadow-[var(--shadow-md)]" noValidate>
        <div className="flex items-center gap-3"><Emblem className="h-10 w-10" /><div><h1 className="font-bold">تغییر رمز عبور</h1><p className="text-xs text-muted-foreground">برای ادامه، رمز موقت را با رمز شخصی جایگزین کنید.</p></div></div>
        {(['current', 'next', 'confirm'] as const).map((k) => (
          <div key={k} className="space-y-1.5">
            <Label htmlFor={k}>{labels[k]}</Label>
            <Input id={k} type="password" dir="ltr" className="h-11 rounded-xl" autoComplete={k === 'current' ? 'current-password' : 'new-password'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={k === 'confirm' && mismatch} />
            {k === 'confirm' && mismatch && <p className="text-xs text-destructive">تکرار رمز یکسان نیست</p>}
          </div>
        ))}
        <ErrorNote message={err} onClose={() => setErr('')} />
        <Button type="submit" className="h-11 w-full" disabled={!valid || busy}>{busy ? <Loader2 className="ms-2 h-4 w-4 animate-spin" /> : <KeyRound className="ms-2 h-4 w-4" />}ثبت رمز جدید</Button>
        <Button type="button" variant="ghost" className="w-full" onClick={signOut}>خروج</Button>
      </form>
    </div>
  );
}
