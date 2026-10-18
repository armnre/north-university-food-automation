import { useState } from 'react';
import { Loader2, Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { staffList, staffSave } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { ROLES, errMsg } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';

type U = { id: string; username: string; fullName: string; role: string; status: string; contractorId: string | null; contractorName: string | null; cafeteriaId: string | null; cafeteriaName: string | null };
type Form = { id?: string; username: string; fullName: string; role: string; status: string; password: string };
const empty: Form = { username: '', fullName: '', role: 'Operator', status: 'Active', password: '' };

export default function UsersPage() {
  const { token, me } = useSession();
  const isSuper = me?.kind === 'staff' && me.staff.role === 'SuperAdmin';
  const roleOptions = Object.entries(ROLES).filter(([k]) => isSuper || (k !== 'SuperAdmin' && k !== 'StudentAffairs'));
  const { data, error, loading, reload } = useLoad(async (t) => {
    const u = await staffList({ token: t });
    return { users: (u as { users: U[] }).users };
  });
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await staffSave({ token, id: form.id, username: form.username, fullName: form.fullName, role: form.role as 'Operator', status: form.status as 'Active', password: form.password || undefined });
      toast.success('کاربر ذخیره شد.'); setForm(null); reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const valid = form && form.username.length >= 3 && form.fullName.length >= 2 && (form.id || form.password.length >= 10) && (!form.password || form.password.length >= 10);
  return (
    <>
      <PageHeader title="کاربران و نقش‌ها" subtitle="حساب‌های مدیریتی از حساب‌های دانشجویی جدا هستند. معاونت دانشجویی می‌تواند پیمانکار، اپراتور سلف و مسئول مالی را تعریف کند." actions={<Button onClick={() => setForm({ ...empty })}><Plus className="ms-1 h-4 w-4" />کاربر جدید</Button>} />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.users.length ? <EmptyState title="کاربری وجود ندارد" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">نام کاربری</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="text-right">نقش</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {data.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-sm" dir="ltr">{u.username}</TableCell><TableCell>{u.fullName}</TableCell><TableCell>{ROLES[u.role] ?? u.role}</TableCell>
                  <TableCell><Pill tone={u.status === 'Active' ? 'success' : 'muted'}>{u.status === 'Active' ? 'فعال' : 'غیرفعال'}</Pill></TableCell>
                  <TableCell><Button size="sm" variant="ghost" aria-label="ویرایش" onClick={() => setForm({ id: u.id, username: u.username, fullName: u.fullName, role: u.role, status: u.status, password: '' })}><Pencil className="h-4 w-4" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={!!form} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{form?.id ? 'ویرایش کاربر' : 'کاربر جدید'}</DialogTitle></DialogHeader>
          {form && data && (
            <div className="grid gap-3">
              <div className="space-y-1.5"><Label>نام کاربری</Label><Input dir="ltr" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>نام و نام خانوادگی</Label><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>نقش</Label><Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{roleOptions.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
                <div className="space-y-1.5"><Label>وضعیت</Label><Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Active">فعال</SelectItem><SelectItem value="Inactive">غیرفعال</SelectItem></SelectContent></Select></div>
              </div>
              <div className="space-y-1.5"><Label>{form.id ? 'رمز عبور جدید (اختیاری)' : 'رمز عبور'}</Label><Input type="password" dir="ltr" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />{form.password && form.password.length < 10 && <p className="text-xs text-destructive">حداقل ۱۰ کاراکتر</p>}</div>
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setForm(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={!valid || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
