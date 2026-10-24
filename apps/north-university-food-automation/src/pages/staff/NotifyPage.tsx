import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { notificationsAdmin } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill, Section } from '../../components/ui-kit';
import { errMsg, faDateTime, faDigits } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type N = { id: string; title: string; body: string; createdAt: string; studentNumber: string | null };

export default function NotifyPage() {
  const { token } = useSession();
  const { data, error, loading, reload, setData } = useLoad(async (t) => ((await notificationsAdmin({ token: t })) as { notifications: N[] }).notifications);
  const [f, setF] = useState({ title: '', body: '', studentNumber: '' });
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = (await notificationsAdmin({ token, send: { title: f.title, body: f.body, studentNumber: f.studentNumber || undefined } })) as { notifications: N[] };
      setData(r.notifications); setF({ title: '', body: '', studentNumber: '' }); toast.success('اعلان ارسال شد.');
    } catch (e2) { toast.error(errMsg(e2)); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="اعلان‌ها" subtitle="اعلان همگانی برای همه‌ی دانشجویان یا اعلان شخصی برای یک دانشجو" />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <Section title="ارسال اعلان">
          <form onSubmit={send} className="space-y-3">
            <div className="space-y-1.5"><Label>عنوان</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>متن</Label><Textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>شماره دانشجویی (برای اعلان شخصی؛ خالی = همگانی)</Label><Input dir="ltr" value={f.studentNumber} onChange={(e) => setF({ ...f, studentNumber: e.target.value })} /></div>
            <Button type="submit" disabled={busy || f.title.trim().length < 2 || f.body.trim().length < 2}>{busy ? <Loader2 className="ms-2 h-4 w-4 animate-spin" /> : <Send className="ms-2 h-4 w-4" />}ارسال</Button>
          </form>
        </Section>
        <Section title="اعلان‌های اخیر">
          {loading ? <LoadingBlock rows={3} /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.length ? <EmptyState title="اعلانی ارسال نشده است" /> : (
            <ul className="divide-y">{data.map((n) => <li key={n.id} className="py-3"><div className="flex items-center justify-between gap-2"><span className="font-medium">{n.title}</span><Pill tone={n.studentNumber ? 'info' : 'muted'}>{n.studentNumber ? faDigits(n.studentNumber) : 'همگانی'}</Pill></div><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{n.body}</p><div className="mt-1 text-xs text-muted-foreground">{faDateTime(n.createdAt)}</div></li>)}</ul>
          )}
        </Section>
      </div>
    </>
  );
}
