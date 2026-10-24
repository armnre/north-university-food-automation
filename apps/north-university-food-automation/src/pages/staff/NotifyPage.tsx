import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { notificationsAdmin } from '../../lib/api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill, Section } from '../../components/ui-kit';
import { errMsg, faDateTime, faDigits } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type N = { id: string; title: string; body: string; audience: string; createdAt: string; studentNumber: string | null };
const AUD: Record<string, string> = { all: 'همگانی', students: 'دانشجویان', employees: 'کارمندان', personal: 'شخصی' };

export default function NotifyPage() {
  const { token } = useSession();
  const { data, error, loading, reload } = useLoad(async (t) => ((await notificationsAdmin({ token: t })) as { notifications: N[] }).notifications);
  const [f, setF] = useState({ title: '', body: '', studentNumber: '', audience: 'all' });
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      await notificationsAdmin({ token, send: { title: f.title, body: f.body, studentNumber: f.studentNumber || undefined, audience: f.audience } });
      setF({ title: '', body: '', studentNumber: '', audience: 'all' }); toast.success('اعلان ارسال شد.'); reload();
    } catch (e2) { toast.error(errMsg(e2)); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="اعلان‌ها" subtitle="اعلان گروهی برای همه، دانشجویان یا کارمندان؛ یا اعلان شخصی برای یک دانشجو" />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <Section title="ارسال اعلان">
          <form onSubmit={send} className="space-y-3">
            <div className="space-y-1.5"><Label>عنوان</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>متن</Label><Textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>گیرندگان</Label><Select value={f.audience} onValueChange={(v) => setF({ ...f, audience: v })} disabled={!!f.studentNumber}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">همه</SelectItem><SelectItem value="students">فقط دانشجویان</SelectItem><SelectItem value="employees">فقط کارمندان</SelectItem></SelectContent></Select></div>
            <div className="space-y-1.5"><Label>شماره دانشجویی (برای اعلان شخصی؛ خالی = گروهی)</Label><Input dir="ltr" value={f.studentNumber} onChange={(e) => setF({ ...f, studentNumber: e.target.value })} /></div>
            <Button type="submit" disabled={busy || f.title.trim().length < 2 || f.body.trim().length < 2}>{busy ? <Loader2 className="ms-2 h-4 w-4 animate-spin" /> : <Send className="ms-2 h-4 w-4" />}ارسال</Button>
          </form>
        </Section>
        <Section title="اعلان‌های اخیر">
          {loading ? <LoadingBlock rows={3} /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.length ? <EmptyState title="اعلانی ارسال نشده است" /> : (
            <ul className="divide-y">{data.map((n) => <li key={n.id} className="py-3"><div className="flex items-center justify-between gap-2"><span className="font-medium">{n.title}</span><Pill tone={n.studentNumber ? 'info' : 'muted'}>{n.studentNumber ? faDigits(n.studentNumber) : AUD[n.audience] ?? n.audience}</Pill></div><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{n.body}</p><div className="mt-1 text-xs text-muted-foreground">{faDateTime(n.createdAt)}</div></li>)}</ul>
          )}
        </Section>
      </div>
    </>
  );
}
