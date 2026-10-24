import { useState } from 'react';
import { Copy, Loader2, Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { catalogList, staffList, staffSave } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { ROLES, errMsg, faDateTime } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

type U = { id: string; username: string; fullName: string; role: string; active: boolean; cafeteriaId: string | null; cafeteriaName: string; contractorId: string | null; mobile: string; lastLoginAt: string | null; editable: boolean };
type Ref = { id: string; name: string };
type Form = { id?: string; username: string; fullName: string; role: string; active: boolean; cafeteriaId: string; contractorId: string; mobile: string; resetPassword: boolean };
const NONE = '__none__';

export default function UsersPage() {
  const { data, error, loading, reload } = useLoad(async () => {
    const [s, c] = await Promise.all([staffList(), catalogList()]);
    return { ...(s as { staff: U[]; manageableRoles: string[] }), cafeterias: (c.cafeterias as Ref[]), contractors: (c.contractors as Ref[]) };
  });
  const [form, setForm] = useState<Form | null>(null);
  const [temp, setTemp] = useState<{ user: string; pass: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = data?.manageableRoles ?? [];
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const r = await staffSave({ ...form, cafeteriaId: form.cafeteriaId || null, contractorId: form.contractorId || null, mobile: form.mobile || undefined });
      if (r.temporaryPassword) setTemp({ user: form.username, pass: r.temporaryPassword }); else toast.success('کاربر ذخیره شد.');
      setForm(null); reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const valid = form && /^[a-zA-Z0-9._-]{3,50}$/.test(form.username) && form.fullName.trim().length >= 2 && (form.role !== 'Operator' || !!form.cafeteriaId) && (form.role !== 'Contractor' || !!form.contractorId);
  const newForm = (): Form => ({ username: '', fullName: '', role: roles[0] ?? 'Operator', active: true, cafeteriaId: '', contractorId: '', mobile: '', resetPassword: false });
  return (
    <>
      <PageHeader title="کاربران و نقش‌ها" subtitle="حساب‌های کارکنان از حساب دانشجو و کارمند جداست. هر نقش فقط نقش‌های پایین‌تر از خود را می‌سازد." actions={roles.length > 0 && <Button onClick={() => setForm(newForm())}><Plus className="ms-1 h-4 w-4" />کاربر جدید</Button>} />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.staff.length ? <EmptyState title="کاربری وجود ندارد" /> : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead className="text-right">نام کاربری</TableHead><TableHead className="text-right">نام</TableHead><TableHead className="text-right">نقش</TableHead><TableHead className="hidden text-right md:table-cell">سلف</TableHead><TableHead className="hidden text-right lg:table-cell">آخرین ورود</TableHead><TableHead className="text-right">وضعیت</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {data.staff.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-sm" dir="ltr">{u.username}</TableCell><TableCell>{u.fullName}</TableCell><TableCell>{ROLES[u.role] ?? u.role}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{u.cafeteriaName || '—'}</TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">{faDateTime(u.lastLoginAt)}</TableCell>
                  <TableCell><Pill tone={u.active ? 'success' : 'muted'}>{u.active ? 'فعال' : 'غیرفعال'}</Pill></TableCell>
                  <TableCell>{u.editable && <Button size="sm" variant="ghost" aria-label="ویرایش" onClick={() => setForm({ id: u.id, username: u.username, fullName: u.fullName, role: u.role, active: u.active, cafeteriaId: u.cafeteriaId ?? '', contractorId: u.contractorId ?? '', mobile: u.mobile, resetPassword: false })}><Pencil className="h-4 w-4" /></Button>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={!!form} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{form?.id ? 'ویرایش کاربر' : 'کاربر جدید'}</DialogTitle><DialogDescription>رمز موقت پس از ذخیره یک بار نمایش داده می‌شود و کاربر در اولین ورود باید آن را تغییر دهد.</DialogDescription></DialogHeader>
          {form && data && (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>نام کاربری</Label><Input dir="ltr" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>نام و نام خانوادگی</Label><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>نقش</Label><Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{roles.filter((r) => r !== 'Employee').map((k) => <SelectItem key={k} value={k}>{ROLES[k] ?? k}</SelectItem>)}</SelectContent></Select></div>
                <div className="space-y-1.5"><Label>موبایل (اختیاری)</Label><Input dir="ltr" inputMode="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></div>
              </div>
              <div className="space-y-1.5"><Label>سلف {form.role === 'Operator' ? '(الزامی)' : '(اختیاری)'}</Label><Select value={form.cafeteriaId || NONE} onValueChange={(v) => setForm({ ...form, cafeteriaId: v === NONE ? '' : v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>—</SelectItem>{data.cafeterias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>
              {form.role === 'Contractor' && <div className="space-y-1.5"><Label>پیمانکار (الزامی)</Label><Select value={form.contractorId || NONE} onValueChange={(v) => setForm({ ...form, contractorId: v === NONE ? '' : v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>—</SelectItem>{data.contractors.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>}
              {form.id && (
                <div className="grid gap-2 rounded-lg border p-3 text-sm">
                  <label className="flex items-center justify-between">فعال<Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} /></label>
                  <label className="flex items-center justify-between">صدور رمز موقت جدید<Switch checked={form.resetPassword} onCheckedChange={(v) => setForm({ ...form, resetPassword: v })} /></label>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setForm(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={!valid || busy}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!temp} onOpenChange={(o) => !o && setTemp(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>رمز موقت</DialogTitle><DialogDescription>این رمز دیگر نمایش داده نمی‌شود. آن را به‌صورت امن به کاربر <b dir="ltr">{temp?.user}</b> بدهید.</DialogDescription></DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-muted p-3"><code dir="ltr" className="flex-1 font-mono text-base">{temp?.pass}</code><Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(temp?.pass ?? ''); toast.success('کپی شد'); }}><Copy className="h-4 w-4" /></Button></div>
          <DialogFooter><Button onClick={() => setTemp(null)}>بستن</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
