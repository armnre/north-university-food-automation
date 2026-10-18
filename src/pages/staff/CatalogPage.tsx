import { useState } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { catalogList, catalogSave } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Switch } from '@project/components/ui/switch';
import { Textarea } from '@project/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@project/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import { errMsg } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { Catalog } from '../../lib/types';

type Item =
  | { kind: 'contractor'; id?: string; name: string; contractNumber: string; contactPhone: string; active: boolean }
  | { kind: 'cafeteria'; id?: string; name: string; location: string; contractorId: string | null; active: boolean }
  | { kind: 'food'; id?: string; name: string; description: string; active: boolean; isDemo: boolean };

function Row({ title, sub, active, extra, onEdit }: { title: string; sub?: string; active: boolean; extra?: React.ReactNode; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0"><div className="flex items-center gap-2 font-medium">{title}{extra}</div>{sub && <div className="truncate text-sm text-muted-foreground">{sub}</div>}</div>
      <div className="flex items-center gap-2"><Pill tone={active ? 'success' : 'muted'}>{active ? 'فعال' : 'غیرفعال'}</Pill><Button size="icon" variant="ghost" aria-label="ویرایش" onClick={onEdit}><Pencil className="h-4 w-4" /></Button></div>
    </div>
  );
}

export default function CatalogPage() {
  const { token } = useSession();
  const { data, error, loading, reload } = useLoad(async (t) => (await catalogList({ token: t })) as Catalog);
  const [item, setItem] = useState<Item | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!item) return;
    setBusy(true);
    try { await catalogSave({ token, item }); toast.success('ذخیره شد.'); setItem(null); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  if (loading) return <LoadingBlock />;
  if (error || !data) return <ErrorState message={error ?? ''} onRetry={reload} />;
  const f = <T extends { name: string }>(xs: T[]) => xs.filter((x) => x.name.includes(q));
  return (
    <>
      <PageHeader title="غذا، سلف و پیمانکار" subtitle="رکوردها حذف نمی‌شوند؛ برای خارج کردن از چرخه، غیرفعال کنید." />
      <Input className="mb-4 max-w-sm" placeholder="جست‌وجو با نام" value={q} onChange={(e) => setQ(e.target.value)} />
      <Tabs defaultValue="food">
        <TabsList className="mb-4"><TabsTrigger value="food">غذاها</TabsTrigger><TabsTrigger value="cafeteria">سلف‌ها</TabsTrigger><TabsTrigger value="contractor">پیمانکاران</TabsTrigger></TabsList>
        <TabsContent value="food" className="space-y-2">
          <Button size="sm" onClick={() => setItem({ kind: 'food', name: '', description: '', active: true, isDemo: false })}><Plus className="ms-1 h-4 w-4" />غذای جدید</Button>
          {f(data.foods).length === 0 ? <EmptyState title="غذایی تعریف نشده است" /> : f(data.foods).map((x) => <Row key={x.id} title={x.name} sub={x.description} active={x.active} extra={x.isDemo ? <Pill tone="warning">نمایشی</Pill> : null} onEdit={() => setItem({ kind: 'food', ...x })} />)}
        </TabsContent>
        <TabsContent value="cafeteria" className="space-y-2">
          <Button size="sm" onClick={() => setItem({ kind: 'cafeteria', name: '', location: '', contractorId: null, active: true })}><Plus className="ms-1 h-4 w-4" />سلف جدید</Button>
          {f(data.cafeterias).length === 0 ? <EmptyState title="سلفی تعریف نشده است" /> : f(data.cafeterias).map((x) => <Row key={x.id} title={x.name} sub={[x.location, x.contractorName && `پیمانکار: ${x.contractorName}`].filter(Boolean).join(' · ')} active={x.active} onEdit={() => setItem({ kind: 'cafeteria', id: x.id, name: x.name, location: x.location, contractorId: x.contractorId, active: x.active })} />)}
        </TabsContent>
        <TabsContent value="contractor" className="space-y-2">
          <Button size="sm" onClick={() => setItem({ kind: 'contractor', name: '', contractNumber: '', contactPhone: '', active: true })}><Plus className="ms-1 h-4 w-4" />پیمانکار جدید</Button>
          {f(data.contractors).length === 0 ? <EmptyState title="پیمانکاری تعریف نشده است" /> : f(data.contractors).map((x) => <Row key={x.id} title={x.name} sub={[x.contractNumber && `قرارداد ${x.contractNumber}`, x.contactPhone].filter(Boolean).join(' · ')} active={x.active} onEdit={() => setItem({ kind: 'contractor', ...x })} />)}
        </TabsContent>
      </Tabs>
      <Dialog open={!!item} onOpenChange={(o) => !o && !busy && setItem(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{item?.id ? 'ویرایش' : 'افزودن'} {item?.kind === 'food' ? 'غذا' : item?.kind === 'cafeteria' ? 'سلف' : 'پیمانکار'}</DialogTitle></DialogHeader>
          {item && (
            <div className="grid gap-3">
              <div className="space-y-1.5"><Label>نام</Label><Input value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} /></div>
              {item.kind === 'food' && <>
                <div className="space-y-1.5"><Label>توضیحات و اطلاعات ضروری</Label><Textarea value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} /></div>
                <label className="flex items-center justify-between text-sm">داده‌ی نمایشی (فقط برای آزمایش)<Switch checked={item.isDemo} onCheckedChange={(v) => setItem({ ...item, isDemo: v })} /></label>
              </>}
              {item.kind === 'cafeteria' && <>
                <div className="space-y-1.5"><Label>محل</Label><Input value={item.location} onChange={(e) => setItem({ ...item, location: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>پیمانکار</Label><Select value={item.contractorId ?? undefined} onValueChange={(v) => setItem({ ...item, contractorId: v })}><SelectTrigger><SelectValue placeholder="انتخاب پیمانکار" /></SelectTrigger><SelectContent>{data.contractors.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>
              </>}
              {item.kind === 'contractor' && <>
                <div className="space-y-1.5"><Label>شماره قرارداد</Label><Input value={item.contractNumber} onChange={(e) => setItem({ ...item, contractNumber: e.target.value })} /></div>
                <div className="space-y-1.5"><Label>تلفن تماس</Label><Input dir="ltr" value={item.contactPhone} onChange={(e) => setItem({ ...item, contactPhone: e.target.value })} /></div>
              </>}
              <label className="flex items-center justify-between text-sm">فعال<Switch checked={item.active} onCheckedChange={(v) => setItem({ ...item, active: v })} /></label>
            </div>
          )}
          <DialogFooter className="gap-2"><Button variant="outline" onClick={() => setItem(null)} disabled={busy}>انصراف</Button><Button onClick={save} disabled={busy || !item || item.name.trim().length < 2}>{busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}ذخیره</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
