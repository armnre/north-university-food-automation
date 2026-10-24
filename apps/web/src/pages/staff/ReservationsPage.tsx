import { useState } from 'react';
import { useDebounce } from 'use-debounce';
import { Ban, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { adminCancelReservation, catalogList, reservationsAdminList } from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Textarea } from '@project/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorNote, ErrorState, LoadingBlock, PageHeader, Pill } from '../../components/ui-kit';
import OfflineConflictsPanel from '../../components/OfflineConflictsPanel';
import { MEALS, RES_STATUS, addDays, downloadCsv, errMsg, faDate, faDateTime, faDigits, rial, showCode, tehranToday } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { useSession } from '../../lib/session';
import type { AdminReservation, Catalog } from '../../lib/types';

const ALL = '__all__';
export default function ReservationsPage() {
  const { me } = useSession();
  const canAdminCancel = me?.kind === 'staff' && me.staff.perms.includes('reservationCancel');
  const [from, setFrom] = useState(addDays(tehranToday(), -7));
  const [to, setTo] = useState(addDays(tehranToday(), 7));
  const [status, setStatus] = useState(ALL);
  const [caf, setCaf] = useState(ALL);
  const [q, setQ] = useState('');
  const [dq] = useDebounce(q, 350);
  const [page, setPage] = useState(0);
  const [cancelTarget, setCancelTarget] = useState<AdminReservation | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState('');

  const cat = useLoad(async () => (await catalogList()) as Catalog);
  const { data, error, loading, reload } = useLoad(
    async () =>
      (await reservationsAdminList({
        from,
        to,
        status: status === ALL ? undefined : status,
        cafeteriaId: caf === ALL ? undefined : caf,
        search: dq || undefined,
        offset: page * 100,
      })) as { reservations: AdminReservation[]; hasMore: boolean },
    [from, to, status, caf, dq, page],
  );

  const exportCsv = () =>
    data &&
    downloadCsv(
      'reservations.csv',
      ['کد', 'تاریخ', 'وعده', 'غذا', 'سلف', 'شماره دانشجویی', 'نام', 'مبلغ (ریال)', 'وضعیت', 'زمان تحویل'],
      data.reservations.map((r) => [
        showCode(r.code),
        r.serviceDate,
        MEALS[r.mealSlot] ?? r.mealSlot,
        r.foodName,
        r.cafeteriaName,
        r.holderIdentifier,
        r.holderName,
        r.priceRial,
        RES_STATUS[r.status]?.label ?? r.status,
        r.deliveredAt ?? '',
      ]),
    );

  const submitCancel = async () => {
    if (!cancelTarget || reason.trim().length < 5) return;
    setBusy(true);
    setCancelErr('');
    try {
      const res = await adminCancelReservation(cancelTarget.id, reason.trim());
      toast.success(`رزرو لغو شد و ${rial(res.refundedRial)} به اعتبار داخلی دانشجو بازگشت.`);
      setCancelTarget(null);
      setReason('');
      reload();
    } catch (e) {
      setCancelErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="مدیریت رزروها"
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={!data?.reservations.length}>
            <Download className="ms-1 h-4 w-4" />
            خروجی CSV
          </Button>
        }
      />
      <OfflineConflictsPanel />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} aria-label="از تاریخ" />
        <Input type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} aria-label="تا تاریخ" />
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>همه‌ی وضعیت‌ها</SelectItem>
            {Object.entries(RES_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={caf} onValueChange={(v) => { setCaf(v); setPage(0); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>همه‌ی سلف‌ها</SelectItem>
            {cat.data?.cafeterias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input placeholder="شماره دانشجویی، نام یا کد" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      </div>
      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data?.reservations.length ? (
        <EmptyState title="رزروی با این فیلترها یافت نشد" />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">کد</TableHead>
                <TableHead className="text-right">تاریخ / وعده</TableHead>
                <TableHead className="text-right">غذا</TableHead>
                <TableHead className="hidden text-right md:table-cell">سلف</TableHead>
                <TableHead className="text-right">دانشجو</TableHead>
                <TableHead className="text-right">مبلغ</TableHead>
                <TableHead className="text-right">وضعیت</TableHead>
                {canAdminCancel && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.reservations.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs" dir="ltr">{showCode(r.code)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {faDate(r.serviceDate)}
                    <div className="text-xs text-muted-foreground">{MEALS[r.mealSlot]}</div>
                  </TableCell>
                  <TableCell>{r.foodName}</TableCell>
                  <TableCell className="hidden md:table-cell">{r.cafeteriaName}</TableCell>
                  <TableCell>
                    <div className="num">{faDigits(r.holderIdentifier)}</div>
                    <div className="text-xs text-muted-foreground">{r.holderName}</div>
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">{rial(r.priceRial)}</TableCell>
                  <TableCell>
                    <Pill tone={RES_STATUS[r.status]?.tone ?? 'muted'}>{RES_STATUS[r.status]?.label ?? r.status}</Pill>
                    {r.deliveredAt && <div className="mt-1 text-[11px] text-muted-foreground">{faDateTime(r.deliveredAt)}</div>}
                  </TableCell>
                  {canAdminCancel && (
                    <TableCell className="whitespace-nowrap">
                      {r.status === 'Reserved' && (
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { setCancelTarget(r); setReason(''); setCancelErr(''); }}>
                          <Ban className="ms-1 h-4 w-4" />
                          لغو اداری
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="mt-4 flex justify-center gap-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>قبلی</Button>
        <Button size="sm" variant="outline" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>بعدی</Button>
      </div>

      <Dialog open={!!cancelTarget} onOpenChange={(o) => !o && !busy && setCancelTarget(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>لغو اداری رزرو و بازپرداخت</DialogTitle>
            <DialogDescription>
              {cancelTarget && `${cancelTarget.holderName} (${faDigits(cancelTarget.holderIdentifier)}) · ${cancelTarget.foodName} · ${faDate(cancelTarget.serviceDate)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="admin-cancel-reason">دلیل لغو اداری (الزامی، حداقل ۵ کاراکتر)</Label>
            <Textarea id="admin-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً درخواست معاونت دانشجویی یا مشکل توزیع وعده" />
            <ErrorNote message={cancelErr} onClose={() => setCancelErr('')} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCancelTarget(null)} disabled={busy}>انصراف</Button>
            <Button variant="destructive" onClick={submitCancel} disabled={busy || reason.trim().length < 5}>
              {busy && <Loader2 className="ms-2 h-4 w-4 animate-spin" />}
              لغو و بازپرداخت به اعتبار داخلی
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
