import { useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { employeeSave } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { errMsg } from '../lib/format';

export type Employee = { id: string; username: string; firstName: string; lastName: string; kind: string; personnelCode: string; mobile: string; active: boolean; lastLoginAt: string | null; balanceRial: number };
export const EMP_KINDS: Record<string, string> = { Staff: 'کارمند', Faculty: 'هیئت علمی', Contractor: 'پیمانکار' };

export default function EmployeeDialog({ employee, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ username: employee?.username ?? '', firstName: employee?.firstName ?? '', lastName: employee?.lastName ?? '', kind: employee?.kind ?? 'Staff', personnelCode: employee?.personnelCode ?? '', mobile: employee?.mobile ?? '', active: employee?.active ?? true, resetPassword: false });
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const userOk = /^[a-zA-Z0-9._-]{3,50}$/.test(f.username);
  const valid = userOk && f.firstName.trim() && f.lastName.trim();
  const save = async () => {
    setBusy(true);
    try {
      const r = await employeeSave({ ...f, id: employee?.id, personnelCode: f.personnelCode || undefined, mobile: f.mobile || undefined });
      onSaved();
      if (r.temporaryPassword) setTemp(r.temporaryPassword); else { toast.success('ذخیره شد.'); onClose(); }
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader><DialogTitle>{employee ? 'ویرایش کارمند' : 'کارمند جدید'}</DialogTitle><DialogDescription>رمز موقت فقط یک بار نمایش داده می‌شود و کاربر در اولین ورود باید آن را تغییر دهد.</DialogDescription></DialogHeader>
        {temp ? (
          <div className="space-y-3">
            <p className="text-sm">رمز موقت برای <b dir="ltr">{f.username}</b>:</p>
            <div className="flex items-center gap-2 rounded-lg border bg-muted p-3"><code dir="ltr" className="flex-1 font-mono text-base">{temp}</code><Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(temp); toast.success('کپی شد'); }}><Copy className="h-4 w-4" /></Button></div>
            <DialogFooter><Button onClick={onClose}>بستن</Button></DialogFooter>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>نام</Label><Input value={f.firstName} onChange={set('firstName')} /></div>
              <div className="space-y-1.5"><Label>نام خانوادگی</Label><Input value={f.lastName} onChange={set('lastName')} /></div>
              <div className="space-y-1.5"><Label>نام کاربری</Label><Input dir="ltr" value={f.username} onChange={set('username')} />{f.username && !userOk && <p className="text-xs text-destructive">فقط حروف انگلیسی، عدد و . _ - (۳ تا ۵۰ نویسه)</p>}</div>
              <div className="space-y-1.5"><Label>نوع</Label><Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(EMP_KINDS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>کد پرسنلی (اختیاری)</Label><Input dir="ltr" value={f.personnelCode} onChange={set('personnelCode')} /></div>
              <div className="space-y-1.5"><Label>موبایل (اختیاری)</Label><Input dir="ltr" inputMode="tel" value={f.mobile} onChange={set('mobile')} /></div>
            </div>
            {employee && (
              <div className="grid gap-2 rounded-lg border p-3 text-sm">
                <label className="flex items-center justify-between">فعال<Switch checked={f.active} onCheckedChange={(v) => setF({ ...f, active: v })} /></label>
                <label className="flex items-center justify-between">صدور رمز موقت جدید<Switch checked={f.resetPassword} onCheckedChange={(v) => setF({ ...f, resetPassword: v })} /></label>
              </div>
            )}
            <DialogFooter className="gap-2"><Button variant="outline" onClick={onClose} disabled={busy}>انصراف</Button><Button onClick={save} disabled={busy || !valid}>{busy && <Loader2 className="ms-1 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
