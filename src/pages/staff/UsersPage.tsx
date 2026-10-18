import { useState } from 'react';
import { Loader2, Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { catalogList, staffList, staffSave } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { ROLES, errMsg } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { Catalog } from '../../lib/types';

type U = { id: string; username: string; fullName: string; role: string; status: string; contractorId: string | null; contractorName: string | null; cafeteriaId: string | null; cafeteriaName: string | null };
type Form = { id?: string; username: string; fullName: string; role: string; status: string; contractorId: string | null; cafeteriaId: string | null; password: string; reason: string };
const empty: Form = { username: '', fullName: '', role: 'Operator', status: 'Active', contractorId: null, cafeteriaId: null, password: '', reason: '' };

export default function UsersPage() {
  const { token } = useSession();
  const { data, error, loading, reload } = useLoad(async (t) => {
    const [u, c] = await Promise.all([staffList({ token: t }), catalogList({ token: t })]);
    return { users: (u as { users: U[] }).users, catalog: c as Catalog };
  });
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await staffSave({ token, ...form, role: form.role as 'Operator', status: form.status as 'Active', password: form.password || undefined });
      toast.success('کاربر ذخیره شد.'); setForm(null); reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const valid = form && form.username.length >= 3 && form.fullName.length >= 2 && form.reason.trim().length >= 3 && (form.id || form.password.length >= 10) && (!form.password || form.password.length >= 10)
    && (form.role !== 'Contractor' || form.contractorId) && (form.role !== 'Operator' || form.cafeteriaId);
  return (
    <>
      <PageHeader title="کاربران و نقش‌ها" subtitle="حساب‌های مدیریتی از حساب‌های دانشجویی جدا هستند. هر تغییر با دلیل در ممیزی ثبت می‌شود." actions={<Button onClick={() => setForm({ ...empty })}><Plus className="ms-1 h-4 w-4" />کاربر جدید</Button>} />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.users.length ? <EmptyState title="کاربری وجود ندارد" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">نام کاربری</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="text-right">نقش</TableHead><TableHead className="hidden text-right md:table-cell">حوزه</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {data.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-sm" dir="ltr">{u.username}</TableCell><TableCell>{u.fullName}</TableCell><TableCell>{ROLES[u.role] ?? u.role}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{u.contractorName ?? u.cafeteriaName ?? '—'}</TableCell>
                  <TableCell><Pill tone={u.status === 'Active' ? 'success' : 'muted'}>{u.status === 'Active' ? 'فعال' : 'غیرفعال'}</Pill></TableCell>
                  <TableCell><Button size="sm" variant="ghost" aria-label="ویرایش" onClick={() => setForm({ ...u, password: '', reason: '' })}><Pencil className="h-4 w-4" /></Button></TableCell>
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
                <div className="space-y-1.5"><Label>نقش</Label><Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(ROLES).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
                <div className="space-y-1.5"><Label>وضعیت</Label><Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Active">فعال</SelectItem><SelectItem value="Inactive">غیرفعال</SelectItem></SelectContent></Select></div>
              </div>
              {form.role === 'Contractor' && <div className="space-y-1.5"><Label>پیمانکار</Label><Select value={form.contractorId ?? undefined} onValueChange={(v) => setForm({ ...form, contractorId: v })}><SelectTrigger><SelectValue placeholder="انتخاب پیمانکار" /></SelectTrigger><SelectContent>{data.catalog.contractors.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>}
              {form.role === 'Operator' && <div className="space-y-1.5"><Label>سلف</Label><Select value={form.cafeteriaId ?? undefined} onValueChange={(v) => setForm({ ...form, cafeteriaId: v })}><SelectTrigger><SelectValue placeholder="انتخاب سلف" /></SelectTrigger><SelectContent>{data.catalog.cafeterias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>}
              <div className="space-y-1.5"><Label>{form.id ? 'رمز عبور جدید (اختیاری)' : 'رمز عبور'}</Label><Input type="password" dir="ltr" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />{form.password && form.password.length < 10 && <p className="text-xs text-destructive">حداقل ۱۰ کاراکتر</p>}</div>
              <div className="space-y-1.5"><Label>دلیل (برای ممیزی)</Label><Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setForm(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={!valid || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
