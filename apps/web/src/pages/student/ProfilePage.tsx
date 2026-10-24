import { useState } from 'react';
import { Lock, LogOut, MonitorSmartphone, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@project/components/ui/button';
import { ErrorState, LoadingBlock, PageHeader, Pill, Section } from '../../components/ui-kit';
import { authLogoutAll, authRevokeSession, authSessions } from '../../lib/api';
import { errMsg, faDateTime, faDigits } from '../../lib/format';
import { useSession, type StudentMe } from '../../lib/session';
import { useLoad } from '../../lib/useLoad';

export default function ProfilePage({ me }: { me: StudentMe }) {
  const { signOut } = useSession();
  const sessions = useLoad(() => authSessions());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const lastLoginDisplay = me.previousLogin?.at
    ? `${faDateTime(me.previousLogin.at)}${me.previousLogin.ip ? ` (IP: ${me.previousLogin.ip})` : ''}`
    : me.lastLoginAt
      ? faDateTime(me.lastLoginAt)
      : 'اولین ورود ثبت‌شده';

  const rows: [string, string][] = [
    ['نام و نام خانوادگی', me.fullName || '—'],
    ['شماره دانشجویی', faDigits(me.studentNumber)],
    ['کد ملی', faDigits(me.nationalIdMasked)],
    ['دانشکده', me.faculty || '—'],
    ['رشته', me.major || '—'],
    ['مقطع', me.degree || '—'],
    ['سال ورود', me.entryYear ? faDigits(String(me.entryYear)) : '—'],
    ['آخرین ورود', lastLoginDisplay],
  ];

  const handleRevoke = async (sessionId: string) => {
    setBusyId(sessionId);
    try {
      await authRevokeSession(sessionId);
      toast.success('نشست انتخاب‌شده باطل شد.');
      sessions.reload();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleLogoutAll = async () => {
    setRevokingAll(true);
    try {
      await authLogoutAll();
      toast.success('همهٔ نشست‌های فعال بسته شدند.');
      await signOut();
    } catch (err) {
      toast.error(errMsg(err));
      setRevokingAll(false);
    }
  };

  const list = sessions.data?.sessions ?? [];
  const otherCount = list.filter((s) => !s.current).length;

  return (
    <div className="space-y-6">
      <PageHeader title="پروفایل و امنیت نشست" subtitle="اطلاعات هویتی از فایل رسمی معاونت دانشجویی خوانده می‌شود." />

      <Section title="مشخصات دانشجویی و آخرین ورود">
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="border-b pb-3">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-1 font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          برای اصلاح اطلاعات هویتی با معاونت دانشجویی تماس بگیرید. این اطلاعات توسط دانشجو قابل تغییر نیست.
        </p>
      </Section>

      <Section
        title="نشست‌های فعال من"
        actions={
          list.length > 0 ? (
            <Button variant="outline" size="sm" onClick={handleLogoutAll} disabled={revokingAll}>
              <LogOut className="ms-1.5 h-4 w-4" />
              خروج از همهٔ دستگاه‌ها
            </Button>
          ) : undefined
        }
      >
        {otherCount > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] p-3 text-xs leading-5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" />
            <span>
              حساب شما هم‌اکنون در {faDigits(String(otherCount))} دستگاه یا مرورگر دیگر نیز باز است. در صورت عدم شناسایی، نشست‌های ناشناس را باطل کنید.
            </span>
          </div>
        )}

        {sessions.loading ? (
          <LoadingBlock rows={2} />
        ) : sessions.error ? (
          <ErrorState message={sessions.error} onRetry={sessions.reload} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">نشست فعالی یافت نشد.</p>
        ) : (
          <ul className="space-y-2.5">
            {list.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-3.5 text-sm">
                <div className="flex min-w-0 items-start gap-2.5">
                  <MonitorSmartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      <span dir="ltr" className="truncate font-mono text-xs">
                        {s.ip ?? 'IP نامشخص'}
                      </span>
                      {s.current ? <Pill tone="success">این دستگاه</Pill> : <Pill tone="info">دستگاه دیگر</Pill>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.userAgent || 'مرورگر نامشخص'}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      ورود: {faDateTime(s.createdAt)} · آخرین فعالیت: {faDateTime(s.lastSeenAt)}
                    </p>
                  </div>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busyId === s.id}
                    onClick={() => void handleRevoke(s.id)}
                  >
                    <Trash2 className="ms-1 h-4 w-4" />
                    ابطال نشست
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
