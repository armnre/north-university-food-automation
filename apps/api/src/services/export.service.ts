import ExcelJS from 'exceljs';
import { sanitizeCell } from '@food/shared';

/**
 * خروجی گزارش‌ها: CSV (با محافظت CSV-injection) و Excel (exceljs).
 * کد ملی خام در هیچ خروجی‌ای وجود ندارد.
 */

export type CsvColumn = { header: string; key: string };

/** ساخت CSV با BOM برای نمایش صحیح فارسی در Excel و محافظت در برابر formula injection. */
export function toCsv(columns: CsvColumn[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown): string => `"${sanitizeCell(value).replace(/"/g, '""')}"`;
  const header = columns.map((c) => escape(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(row[c.key])).join(','));
  return `\uFEFF${[header, ...body].join('\n')}`;
}

/** ساخت فایل xlsx در حافظه (بدون نوشتن روی دیسک سرور). */
export async function toXlsx(sheetName: string, columns: CsvColumn[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'سامانه اتوماسیون تغذیه دانشگاه شمال';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(14, Math.min(40, c.header.length * 2)) }));
  // در xlsx مقدارها به‌صورت رشته/عدد نوشته می‌شوند (نه formula)، بنابراین
  // محافظت CSV-injection فقط برای خروجی CSV لازم است.
  for (const row of rows) {
    const values: Record<string, unknown> = {};
    for (const column of columns) values[column.key] = row[column.key] ?? '';
    sheet.addRow(values);
  }
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written instanceof ArrayBuffer ? new Uint8Array(written) : (written as unknown as Uint8Array));
}
