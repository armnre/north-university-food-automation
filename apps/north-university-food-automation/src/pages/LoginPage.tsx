import { useEffect, useState } from 'react';
import { Loader2, GraduationCap, Building2, BadgeCheck, Lock } from 'lucide-react';
import { authEmployeeLogin, authSetupAdmin, authSetupStatus, authStaffLogin, authStudentLogin } from '../lib/api';
import { CaptchaBox, captchaFrom, type Captcha } from '../components/AuthExtras';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@project/components/ui/tabs';
import { toast } from 'sonner';
import { Emblem } from '../components/ui-kit';
import { errMsg } from '../lib/format';
import { ErrorNote } from '../components/ui-kit';
import { useSession } from '../lib/session';

function Field({ id, label, error, ...rest }: { id: string; label: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="h-12 rounded-xl bg-card text-base shadow-[var(--shadow-sm)]" aria-invalid={!!error} {...rest} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function StudentForm() {
  const { signIn } = useSession();
  const [sn, setSn] = useState('');
  const [nid, setNid] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [captcha, setCaptcha] = useState<Captcha>(null);
  const [ans, setAns] = useState('');
  const valid = sn.trim().length >= 5 && nid.trim().length === 10 && (!captcha || !!ans);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setErr('');
    try { await authStudentLogin({ studentNumber: sn, nationalId: nid, ...(captcha ? { captchaId: captcha.captchaId, captchaAnswer: ans } : {}) }); await signIn(); }
    catch (e2) { setErr(errMsg(e2)); setCaptcha(captchaFrom(e2)); setAns(''); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field id="sn" label="شماره دانشجویی" inputMode="numeric" autoComplete="username" dir="ltr" value={sn} onChange={(e) => setSn(e.target.value)} />
      <Field id="nid" label="کد ملی" inputMode="numeric" autoComplete="off" dir="ltr" maxLength={10} type="password" value={nid} onChange={(e) => setNid(e.target.value)} error={nid && nid.length !== 10 ? 'کد ملی ۱۰ رقم است' : undefined} />
      {captcha && <CaptchaBox captcha={captcha} answer={ans} onAnswer={setAns} />}
      <ErrorNote message={err} onClose={() => setErr('')} />
      <Button type="submit" className="h-12 w-full text-base font-bold" disabled={!valid || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ورود به سامانه</Button>
      <p className="text-center text-xs text-muted-foreground">ورود فقط با اطلاعات ثبت‌شده توسط معاونت دانشجویی امکان‌پذیر است.</p>
    </form>
  );
}

type LoginMode = 'admin' | 'Staff' | 'Faculty';
const MODE_TEXT: Record<LoginMode, { user: string; pass: string; btn: string; userMode: 'numeric' | 'text' }> = {
  Staff: { user: 'شماره پرسنلی', pass: 'کد ملی', btn: 'ورود کارکنان', userMode: 'numeric' },
  Faculty: { user: 'شماره کارگزینی', pass: 'کد ملی', btn: 'ورود اعضای هیئت علمی', userMode: 'numeric' },
  admin: { user: 'نام کاربری', pass: 'رمز عبور', btn: 'ورود به پنل مدیریت', userMode: 'text' },
};

function StaffForm({ mode }: { mode: LoginMode }) {
  const { signIn } = useSession();
  const [captcha, setCaptcha] = useState<Captcha>(null);
  const [ans, setAns] = useState('');
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Staff tab also serves admins: a non-numeric username signs in to the management panel.
  const adminUser = mode === 'Staff' && /[a-zA-Z]/.test(u);
  const t = adminUser ? { ...MODE_TEXT.admin, user: MODE_TEXT.Staff.user + ' / نام کاربری', btn: 'ورود' } : MODE_TEXT[mode];
  const isEmp = mode !== 'admin' && !adminUser;
  const nidErr = isEmp && p && p.replace(/\D/g, '').length !== 10 && !/[۰-۹]/.test(p) ? 'کد ملی ۱۰ رقم است' : undefined;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const extra = captcha ? { captchaId: captcha.captchaId, captchaAnswer: ans } : {};
    try {
      if (isEmp) await authEmployeeLogin({ username: u.trim(), password: p.trim(), kind: mode, ...extra });
      else await authStaffLogin({ username: u.trim(), password: p, ...extra });
      await signIn();
    }
    catch (e2) { setErr(errMsg(e2)); setCaptcha(captchaFrom(e2)); setAns(''); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field id={`u-${mode}`} label={t.user} dir="ltr" inputMode={t.userMode} autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} />
      <Field id={`p-${mode}`} label={t.pass} dir="ltr" type="password" inputMode={isEmp ? 'numeric' : undefined} maxLength={isEmp ? 10 : undefined} autoComplete={isEmp ? 'off' : 'current-password'} value={p} onChange={(e) => setP(e.target.value)} error={nidErr} />
      {captcha && <CaptchaBox captcha={captcha} answer={ans} onAnswer={setAns} />}
      <ErrorNote message={err} onClose={() => setErr('')} />
      <Button type="submit" className="h-12 w-full text-base font-bold" disabled={!u || !p || (!!captcha && !ans) || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}{t.btn}</Button>
    </form>
  );
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ setupCode: '', username: '', fullName: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const errors = { password: f.password && f.password.length < 10 ? 'حداقل ۱۰ کاراکتر' : '', confirm: f.confirm && f.confirm !== f.password ? 'تکرار رمز مطابقت ندارد' : '' };
  const ok = f.setupCode && f.username.length >= 3 && f.fullName.length >= 2 && f.password.length >= 10 && f.password === f.confirm;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await authSetupAdmin({ setupCode: f.setupCode, username: f.username, fullName: f.fullName, password: f.password }); toast.success('مدیر ارشد ساخته شد. اکنون وارد شوید.'); onDone(); }
    catch (e2) { toast.error(errMsg(e2)); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="rounded-lg bg-accent px-3 py-2 text-xs text-accent-foreground">راه‌اندازی اولیه: هنوز هیچ کاربر مدیریتی وجود ندارد. با کد راه‌اندازی (تنظیم‌شده در Secrets) اولین مدیر ارشد را بسازید.</div>
      <Field id="sc" label="کد راه‌اندازی" type="password" dir="ltr" value={f.setupCode} onChange={set('setupCode')} />
      <Field id="su" label="نام کاربری (انگلیسی)" dir="ltr" value={f.username} onChange={set('username')} />
      <Field id="sf" label="نام و نام خانوادگی" value={f.fullName} onChange={set('fullName')} />
      <Field id="sp" label="رمز عبور" type="password" dir="ltr" value={f.password} onChange={set('password')} error={errors.password} />
      <Field id="spc" label="تکرار رمز عبور" type="password" dir="ltr" value={f.confirm} onChange={set('confirm')} error={errors.confirm} />
      <Button type="submit" className="h-11 w-full" disabled={!ok || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ساخت مدیر ارشد</Button>
    </form>
  );
}

const TABS = [
  { v: 'student', label: 'دانشجو', icon: GraduationCap, hint: 'ورود با شماره دانشجویی و کد ملی' },
  { v: 'Staff', label: 'کارکنان', icon: Building2, hint: 'ورود با شماره پرسنلی و کد ملی — مدیران سامانه با نام کاربری و رمز عبور' },
  { v: 'Faculty', label: 'اساتید', icon: BadgeCheck, hint: 'ورود اعضای هیئت علمی با شماره کارگزینی و کد ملی' },
] as const;

export default function LoginPage() {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [tab, setTab] = useState<string>('student');
  useEffect(() => { authSetupStatus({}).then((r) => setNeedsSetup(r.needsSetup)).catch(() => undefined); }, []);
  const hint = TABS.find((x) => x.v === tab)?.hint;
  return (
    <div className="relative flex min-h-screen flex-col bg-muted/40">
      <div className="hero-surface relative overflow-hidden pb-28 pt-8 text-white">
        <div className="dot-grid pointer-events-none absolute inset-0 opacity-30" />
        <div className="relative mx-auto flex max-w-5xl flex-col items-center px-6 text-center">
          <div className="rounded-3xl bg-white p-2.5 shadow-[var(--shadow-xl)] animate-in fade-in zoom-in-95 duration-500">
            <Emblem className="h-20 w-20 rounded-2xl shadow-none sm:h-24 sm:w-24" />
          </div>
          <p className="mt-4 text-xs font-medium tracking-wide text-white/70">وزارت علوم، تحقیقات و فناوری</p>
          <h1 className="mt-1 text-xl font-extrabold sm:text-2xl">دانشگاه شمال</h1>
          <p className="mt-1 text-sm text-white/80 sm:text-base">سامانه جامع اتوماسیون تغذیه</p>
        </div>
      </div>
      <main className="relative z-10 mx-auto -mt-20 w-full max-w-md flex-1 px-4 pb-10">
        <div className="rounded-3xl border bg-card p-5 shadow-[var(--shadow-xl)] animate-in fade-in slide-in-from-bottom-4 duration-500 sm:p-7">
          <div className="mb-5 text-center">
            <h2 className="text-lg font-bold">ورود به سامانه</h2>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-6 grid h-auto w-full grid-cols-3 gap-1 rounded-2xl p-1">
              {TABS.map(({ v, label, icon: Icon }) => (
                <TabsTrigger key={v} value={v} className="flex flex-col gap-1 rounded-xl py-2 text-xs data-[state=active]:shadow-[var(--shadow-sm)]"><Icon className="h-4 w-4" />{label}</TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="student"><StudentForm /></TabsContent>
            <TabsContent value="Staff">{needsSetup ? <SetupForm onDone={() => setNeedsSetup(false)} /> : <StaffForm mode="Staff" />}</TabsContent>
            <TabsContent value="Faculty"><StaffForm mode="Faculty" /></TabsContent>
          </Tabs>
        </div>
        <div className="mt-6 flex items-center justify-center gap-2 text-center text-[11px] text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />اطلاعات شما محرمانه است و کد ملی در هیچ گزارشی نمایش داده نمی‌شود.
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">© {new Intl.DateTimeFormat('fa-IR', { year: 'numeric' }).format(new Date())} — اداره تغذیه دانشگاه شمال</p>
      </main>
    </div>
  );
}
