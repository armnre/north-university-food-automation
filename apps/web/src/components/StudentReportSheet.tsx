import { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { adminStudentReport, type StudentReport } from '../lib/api';
import { Button } from '@project/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@project/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@project/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { ErrorState, LoadingBlock, Pill, StatCard } from './ui-kit';
import { downloadCsv, errMsg, faDate, faDateTime, faDigits, faNum, LEDGER_TYPES, MEALS, RES_STATUS, rial } from '../lib/format';
import { STUDENT_STATUS } from '../lib/studentStatus';

type Report = StudentReport;

export default function StudentReportSheet({ studentId, onClose }: { studentId: string | null; onClose: () => void }) {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!studentId) return;
    setData(null); setError('');
    adminStudentReport({ studentId }).then(setData).catch((e) => setError(errMsg(e)));
  }, [studentId]);

  const exportCsv = () => {
    if (!data) return;
    const p = data.profile;
    downloadCsv(`report-${p.studentNumber}.csv`, ['بخش', 'تاریخ', 'وعده/نوع', 'غذا/کد', 'سلف', 'مبلغ (ریال)', 'وضعیت'], [
      ['مشخصات', '', p.fullName, p.studentNumber, `${p.major} - ${p.faculty}`, data.stats.balanceRial, STUDENT_STATUS[p.status]?.label ?? p.status],
      ...data.reservations.map((r: Report['reservations'][0]) => ['رزرو', r.serviceDate, MEALS[r.mealSlot] ?? r.mealSlot, r.food, r.cafeteria, r.priceRial, RES_STATUS[r.status]?.label ?? r.status]),
      ...data.ledger.map((e: Report['ledger'][0]) => ['تراکنش', e.createdAt ?? '', LEDGER_TYPES[e.type] ?? e.type, e.trackingCode, '', e.amountRial, '']),
    ]);
  };

  return (
    <Sheet open={!!studentId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="left" dir="rtl" className="w-full overflow-y-auto sm:max-w-2xl print:max-w-none">
        {error ? <ErrorState message={error} /> : !data ? <LoadingBlock rows={6} /> : (
          <>
            <SheetHeader className="text-right">
              <SheetTitle className="flex flex-wrap items-center gap-2">{data.profile.fullName}<Pill tone={STUDENT_STATUS[data.profile.status]?.tone ?? 'muted'}>{STUDENT_STATUS[data.profile.status]?.label ?? data.profile.status}</Pill></SheetTitle>
              <SheetDescription className="num">{faDigits(data.profile.studentNumber)} · کد ملی <span dir="ltr">{data.profile.nationalIdMasked}</span></SheetDescription>
            </SheetHeader>
            <div className="mt-3 flex gap-2 print:hidden">
              <Button size="sm" variant="outline" onClick={exportCsv}><Download className="ms-1 h-4 w-4" />خروجی Excel (CSV)</Button>
              <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="ms-1 h-4 w-4" />چاپ</Button>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border bg-secondary/30 p-4 text-sm sm:grid-cols-3">
              {[['دانشکده', data.profile.faculty], ['رشته', data.profile.major], ['مقطع', data.profile.degree], ['سال ورود', data.profile.entryYear ? faDigits(String(data.profile.entryYear)) : '—'],
                ['افزوده‌شده', faDateTime(data.profile.addedAt)], ['حذف از فهرست', faDateTime(data.profile.removedAt)], ['آخرین واردسازی', data.profile.lastImport ?? '—']].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v || '—'}</dd></div>
              ))}
            </dl>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="موجودی" value={rial(data.stats.balanceRial)} tone="primary" />
              <StatCard label="کل رزروها" value={faNum(data.stats.total)} />
              <StatCard label="تحویل‌شده" value={faNum(data.stats.delivered)} hint={`${faNum(data.stats.reserved)} در انتظار`} />
              <StatCard label="لغو / عدم مراجعه" value={`${faNum(data.stats.cancelled)} / ${faNum(data.stats.expired)}`} />
              <StatCard label="جمع واریزها" value={rial(data.stats.creditsRial)} />
              <StatCard label="جمع برداشت‌ها" value={rial(data.stats.debitsRial)} />
              <StatCard label="هزینه غذا" value={rial(data.stats.spentRial)} />
              <StatCard label="نرخ مراجعه" value={data.stats.delivered + data.stats.expired ? `${faNum(Math.round((data.stats.delivered / (data.stats.delivered + data.stats.expired)) * 100))}٪` : '—'} />
            </div>
            <Tabs defaultValue="res" className="mt-5">
              <TabsList><TabsTrigger value="res">رزروها ({faNum(data.reservations.length)})</TabsTrigger><TabsTrigger value="ledger">تراکنش‌ها ({faNum(data.ledger.length)})</TabsTrigger></TabsList>
              <TabsContent value="res">
                {!data.reservations.length ? <p className="py-6 text-center text-sm text-muted-foreground">رزروی ثبت نشده است.</p> : (
                  <Table><TableHeader><TableRow><TableHead className="text-right">تاریخ</TableHead><TableHead className="text-right">وعده</TableHead><TableHead className="text-right">غذا</TableHead><TableHead className="text-right">مبلغ</TableHead><TableHead className="text-right">وضعیت</TableHead></TableRow></TableHeader>
                    <TableBody>{data.reservations.map((r: Report['reservations'][0]) => (
                      <TableRow key={r.id}><TableCell className="text-xs">{faDate(r.serviceDate)}</TableCell><TableCell>{MEALS[r.mealSlot] ?? r.mealSlot}</TableCell><TableCell>{r.food}<div className="text-xs text-muted-foreground">{r.cafeteria}</div></TableCell><TableCell className="num text-xs">{rial(r.priceRial)}</TableCell><TableCell><Pill tone={RES_STATUS[r.status]?.tone ?? 'muted'}>{RES_STATUS[r.status]?.label ?? r.status}</Pill></TableCell></TableRow>
                    ))}</TableBody></Table>
                )}
              </TabsContent>
              <TabsContent value="ledger">
                {!data.ledger.length ? <p className="py-6 text-center text-sm text-muted-foreground">تراکنشی ثبت نشده است.</p> : (
                  <Table><TableHeader><TableRow><TableHead className="text-right">زمان</TableHead><TableHead className="text-right">نوع</TableHead><TableHead className="text-right">کد پیگیری</TableHead><TableHead className="text-right">مبلغ</TableHead></TableRow></TableHeader>
                    <TableBody>{data.ledger.map((e: Report['ledger'][0], i: number) => (
                      <TableRow key={i}><TableCell className="text-xs">{faDateTime(e.createdAt)}</TableCell><TableCell>{LEDGER_TYPES[e.type] ?? e.type}</TableCell><TableCell className="font-mono text-xs" dir="ltr">{e.trackingCode}</TableCell><TableCell className={`num text-xs ${e.amountRial < 0 ? 'text-destructive' : 'text-[hsl(var(--success))]'}`}>{rial(e.amountRial)}</TableCell></TableRow>
                    ))}</TableBody></Table>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
