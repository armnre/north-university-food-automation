import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, GraduationCap, Building2, BadgeCheck } from 'lucide-react';
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
      <Button type="submit" className="h-11 w-full text-base" disabled={!valid || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ورود به سامانه</Button>
      <p className="text-center text-xs text-muted-foreground">ورود فقط با اطلاعات ثبت‌شده توسط معاونت دانشجویی امکان‌پذیر است.</p>
    </form>
  );
}

function StaffForm({ kind = 'staff' }: { kind?: 'staff' | 'employee' }) {
  const { signIn } = useSession();
  const [captcha, setCaptcha] = useState<Captcha>(null);
  const [ans, setAns] = useState('');
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const login = kind === 'staff' ? authStaffLogin : authEmployeeLogin;
    try { await login({ username: u, password: p, ...(captcha ? { captchaId: captcha.captchaId, captchaAnswer: ans } : {}) }); await signIn(); }
    catch (e2) { setErr(errMsg(e2)); setCaptcha(captchaFrom(e2)); setAns(''); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field id="u" label="نام کاربری" dir="ltr" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} />
      <Field id="p" label="رمز عبور" dir="ltr" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} />
      {captcha && <CaptchaBox captcha={captcha} answer={ans} onAnswer={setAns} />}
      <ErrorNote message={err} onClose={() => setErr('')} />
      <Button type="submit" className="h-11 w-full text-base" disabled={!u || !p || (!!captcha && !ans) || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}{kind === 'staff' ? 'ورود کارکنان' : 'ورود کارمندان'}</Button>
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

export default function LoginPage() {
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => { authSetupStatus({}).then((r) => setNeedsSetup(r.needsSetup)).catch(() => undefined); }, []);
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col lg:items-center lg:justify-center lg:p-10">
        <div className="hero-surface relative overflow-hidden px-6 pb-16 pt-10 text-white lg:hidden">
          <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />
          <div className="absolute -left-16 -top-16 h-48 w-48 rounded-full bg-[hsl(var(--sidebar-primary)/0.3)] blur-3xl" />
          <div className="relative flex items-center gap-3">
            <Emblem className="h-12 w-12 ring-2 ring-white/20 rounded-[12px]" />
            <div><h1 className="text-lg font-extrabold">سامانه اتوماسیون تغذیه</h1><p className="text-sm text-white/70">دانشگاه شمال</p></div>
          </div>
          <p className="relative mt-6 text-2xl font-extrabold leading-snug">رزرو غذا، کیف پول و تحویل سلف — در جیب شما</p>
        </div>
        <div className="relative -mt-8 w-full flex-1 rounded-t-[2rem] bg-background px-6 pb-10 pt-8 lg:mt-0 lg:max-w-sm lg:flex-none lg:rounded-none lg:bg-transparent lg:p-0">
          <div className="mb-8 hidden items-center gap-3 lg:flex">
            <Emblem className="h-11 w-11" />
            <div>
              <h1 className="text-lg font-bold">سامانه اتوماسیون تغذیه</h1>
              <p className="text-sm text-muted-foreground">دانشگاه شمال</p>
            </div>
          </div>
          <Tabs defaultValue="student">
            <TabsList className="mb-6 grid h-12 w-full grid-cols-3 rounded-2xl p-1">
              <TabsTrigger value="student" className="rounded-xl data-[state=active]:shadow-[var(--shadow-sm)]"><GraduationCap className="ms-1.5 h-4 w-4" />دانشجو</TabsTrigger>
              <TabsTrigger value="staff" className="rounded-xl data-[state=active]:shadow-[var(--shadow-sm)]"><Building2 className="ms-1.5 h-4 w-4" />کارکنان</TabsTrigger>
              <TabsTrigger value="employee" className="rounded-xl data-[state=active]:shadow-[var(--shadow-sm)]"><BadgeCheck className="ms-1.5 h-4 w-4" />کارمند</TabsTrigger>
            </TabsList>
            <TabsContent value="student"><StudentForm /></TabsContent>
            <TabsContent value="staff">{needsSetup ? <SetupForm onDone={() => setNeedsSetup(false)} /> : <StaffForm />}</TabsContent>
            <TabsContent value="employee"><StaffForm kind="employee" /></TabsContent>
          </Tabs>
        </div>
      </div>
      <div className="hero-surface relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="dot-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="absolute -left-24 -top-24 h-96 w-96 rounded-full bg-[hsl(var(--sidebar-primary)/0.12)]" />
        <div className="absolute -bottom-32 right-10 h-80 w-80 rounded-full bg-[hsl(var(--sidebar-accent))]" />
        <div className="relative text-sm text-[hsl(var(--sidebar-foreground))]">University of Shomal — Dining Automation System</div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-extrabold leading-snug text-white">رزرو غذا، کیف پول و تحویل سلف<br />در یک سامانه‌ی یکپارچه</h2>
          <ul className="mt-8 space-y-3 text-[hsl(var(--sidebar-foreground))]">
            {['رزرو روزانه با ظرفیت و مهلت مشخص', 'کیف پول داخلی با سوابق مالی قابل پیگیری', 'تحویل غذا با کد QR اختصاصی هر رزرو'].map((t) => (
              <li key={t} className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-[hsl(var(--sidebar-primary))]" />{t}</li>
            ))}
          </ul>
        </div>
        <div className="relative text-xs text-[hsl(var(--sidebar-foreground)/0.7)]">اطلاعات شما محرمانه است و کد ملی در هیچ گزارشی نمایش داده نمی‌شود.</div>
      </div>
    </div>
  );
}
