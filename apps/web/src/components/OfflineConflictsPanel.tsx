import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@project/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { Pill } from './ui-kit';
import { offlineConflicts, type OfflineConflictDto } from '../lib/api';
import { MEALS, faDate, faDateTime, faDigits } from '../lib/format';
import { useLoad } from '../lib/useLoad';

/**
 * پنل نمایش مغایرت‌های همگام‌سازی آفلاین سلف در صفحات مدیریتی (رزروها و گزارش‌ها).
 * بلیت‌هایی را که در فاصلهٔ قطعی اینترنت لغو شده یا هم‌زمان در دو دستگاه آفلاین اسکن شده‌اند برجسته می‌کند.
 */
export default function OfflineConflictsPanel() {
  const { data, loading, reload } = useLoad(() => offlineConflicts());
  const conflicts: OfflineConflictDto[] = data?.conflicts ?? [];

  if (loading || conflicts.length === 0) return null;

  return (
    <div
      className="mb-5 rounded-2xl border-2 border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.08)] p-4"
      role="region"
      aria-label="تعارض‌های همگام‌سازی آفلاین سلف"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-bold text-foreground">
          <AlertTriangle className="h-5 w-5 shrink-0 text-[hsl(var(--warning))]" />
          <span>تعارض‌های همگام‌سازی آفلاین سلف ({faDigits(String(conflicts.length))} مورد نیازمند بررسی)</span>
        </div>
        <Button size="sm" variant="outline" onClick={reload}>
          <RefreshCw className="ms-1.5 h-3.5 w-3.5" />
          به‌روزرسانی تعارض‌ها
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        موارد زیر در زمان قطعی اینترنت سلف به صورت موقت اسکن شده‌اند، اما هنگام همگام‌سازی مشخص شده است که رزرو قبلاً لغو شده یا توسط دستگاه دیگری تحویل ثبت شده بود.
      </p>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">کد بلیت</TableHead>
              <TableHead className="text-right">مشتری / غذا</TableHead>
              <TableHead className="text-right">سلف / اپراتور</TableHead>
              <TableHead className="text-right">زمان اسکن آفلاین</TableHead>
              <TableHead className="text-right">علت تعارض</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conflicts.slice(0, 20).map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs" dir="ltr">
                  {c.reservationCode || '—'}
                </TableCell>
                <TableCell className="text-xs">
                  <div className="font-medium">
                    {c.holderName || '—'} {c.holderIdentifier ? `(${faDigits(c.holderIdentifier)})` : ''}
                  </div>
                  <div className="text-muted-foreground">
                    {c.foodName || '—'}
                    {c.mealSlot ? ` · ${MEALS[c.mealSlot] ?? c.mealSlot}` : ''}
                    {c.serviceDate ? ` · ${faDate(c.serviceDate)}` : ''}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  <div>{c.cafeteriaName || '—'}</div>
                  <div className="text-muted-foreground">{c.operatorName || '—'}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">{faDateTime(c.scannedAt)}</TableCell>
                <TableCell className="text-xs">
                  <Pill tone="warning">تعارض آفلاین</Pill>
                  <div className="mt-1 text-muted-foreground">{c.message}</div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
