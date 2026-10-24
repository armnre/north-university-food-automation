import { useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  downloadEmployeeCredentials,
  employeeResetPassword,
  employeesBulk,
  employeeSave,
  employeesList,
  type EmployeeUpsert,
} from '../../lib/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { Label } from '@project/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@project/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@project/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@project/components/ui/table';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pill, Section } from '../../components/ui-kit';
import { errMsg, faDateTime, faNum, rial } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';

type EmployeeRow = {
  id: string;
  username: string;
  fullName: string;
  customerGroup: 'Employee' | 'Faculty' | 'Contractor';
  department: string;
  mobile: string | null;
  personnelCode: string | null;
  nationalIdMasked: string;
  status: 'Active' | 'Disabled';
  balanceRial: number;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

type EmployeeForm = {
  id?: string;
  username: string;
  fullName: string;
  customerGroup: 'Employee' | 'Faculty' | 'Contractor';
  department: string;
  mobile: string;
  personnelCode: string;
  nationalIdLast4: string;
  status: 'Active' | 'Disabled';
  password: string;
};

const GROUP_LABELS: Record<'Employee' | 'Faculty' | 'Contractor', string> = {
  Employee: 'کارمند اداری',
  Faculty: 'عضو هیئت علمی',
  Contractor: 'پیمانکار / مهمان سازمانی',
};

const EMPTY_FORM: EmployeeForm = {
  username: '',
  fullName: '',
  customerGroup: 'Employee',
  department: '',
  mobile: '',
  personnelCode: '',
  nationalIdLast4: '',
  status: 'Active',
  password: '',
};

const ALL = '__all__';

export default function EmployeesPage() {
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [form, setForm] = useState<EmployeeForm | null>(null);
  const [busy, setBusy] = useState(false);

  // دیالوگ نمایش یک‌بارمصرف رمز موقت (هنگام ساخت تکی یا ریست رمز)
  const [oneTimeSecret, setOneTimeSecret] = useState<{
    username: string;
    fullName: string;
    temporaryPassword: string;
    sessionsRevoked?: number;
  } | null>(null);

  // دیالوگ ریست رمز
  const [resetTarget, setResetTarget] = useState<EmployeeRow | null>(null);
  const [customResetPassword, setCustomResetPassword] = useState('');

  // واردسازی گروهی اکسل + دانلود یک‌بارمصرف اعتبارنامه‌ها
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    created: number;
    skipped: number;
    downloaded: boolean;
  } | null>(null);

  const { data, error, loading, reload } = useLoad(
    async () =>
      (await employeesList({
        search: search.trim() || undefined,
        customerGroup: groupFilter === ALL ? undefined : groupFilter,
        status: statusFilter === ALL ? undefined : statusFilter,
        limit: 200,
      })) as { total: number; employees: EmployeeRow[] },
    [search, groupFilter, statusFilter],
  );

  const openEdit = (row: EmployeeRow) => {
    const digitsLast4 = row.nationalIdMasked.replace(/\D/g, '').slice(-4);
    setForm({
      id: row.id,
      username: row.username,
      fullName: row.fullName,
      customerGroup: row.customerGroup,
      department: row.department ?? '',
      mobile: row.mobile ?? '',
      personnelCode: row.personnelCode ?? '',
      nationalIdLast4: digitsLast4.length === 4 ? digitsLast4 : '',
      status: row.status,
      password: '',
    });
  };

  const formValid =
    !!form &&
    form.username.trim().length >= 3 &&
    form.fullName.trim().length >= 2 &&
    (!form.password || form.password.length >= 10) &&
    (!form.nationalIdLast4 || /^\d{4}$/.test(form.nationalIdLast4));

  const handleSave = async () => {
    if (!form || !formValid) return;
    setBusy(true);
    try {
      const payload: EmployeeUpsert = {
        id: form.id,
        username: form.username.trim(),
        fullName: form.fullName.trim(),
        customerGroup: form.customerGroup,
        department: form.department.trim() || undefined,
        mobile: form.mobile.trim() || undefined,
        personnelCode: form.personnelCode.trim() || undefined,
        nationalIdLast4: form.nationalIdLast4.trim() || undefined,
        status: form.status,
        password: !form.id && form.password.trim() ? form.password : undefined,
      };
      const res = await employeeSave(payload);
      toast.success(form.id ? 'اطلاعات کارمند به‌روزرسانی شد.' : 'حساب کارمند ایجاد شد.');
      const savedUsername = form.username.trim();
      const savedName = form.fullName.trim();
      setForm(null);
      reload();
      if (res.temporaryPassword) {
        setOneTimeSecret({
          username: savedUsername,
          fullName: savedName,
          temporaryPassword: res.temporaryPassword,
        });
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStatus = async (row: EmployeeRow) => {
    const nextStatus: 'Active' | 'Disabled' = row.status === 'Active' ? 'Disabled' : 'Active';
    setBusy(true);
    try {
      const digitsLast4 = row.nationalIdMasked.replace(/\D/g, '').slice(-4);
      await employeeSave({
        id: row.id,
        username: row.username,
        fullName: row.fullName,
        customerGroup: row.customerGroup,
        department: row.department || undefined,
        mobile: row.mobile || undefined,
        personnelCode: row.personnelCode || undefined,
        nationalIdLast4: digitsLast4.length === 4 ? digitsLast4 : undefined,
        status: nextStatus,
      });
      toast.success(
        nextStatus === 'Disabled'
          ? 'حساب غیرفعال شد و تمام نشست‌های فعال کاربر باطل گردید.'
          : 'حساب مجدداً فعال شد.',
      );
      reload();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (!resetTarget) return;
    if (customResetPassword.trim() && customResetPassword.trim().length < 10) {
      toast.error('رمز عبور سفارشی باید حداقل ۱۰ کاراکتر باشد.');
      return;
    }
    setBusy(true);
    try {
      const res = await employeeResetPassword(resetTarget.id, {
        newPassword: customResetPassword.trim() || undefined,
      });
      const target = resetTarget;
      setResetTarget(null);
      setCustomResetPassword('');
      reload();
      if (res.temporaryPassword) {
        setOneTimeSecret({
          username: target.username,
          fullName: target.fullName,
          temporaryPassword: res.temporaryPassword,
          sessionsRevoked: res.sessionsRevoked,
        });
      } else {
        toast.success('رمز عبور بازنشانی شد و نشست‌های فعال باطل گردید.');
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const handleBulkUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      toast.error('فقط فایل اکسل با پسوند xlsx پذیرفته می‌شود.');
      return;
    }
    setBulkBusy(true);
    try {
      const res = await employeesBulk(file);
      setBulkResult({ created: res.created, skipped: res.skipped, downloaded: false });
      toast.success(`واردسازی انجام شد: ${faNum(res.created)} حساب جدید ایجاد شد.`);
      reload();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDownloadOneTimeCredentials = async () => {
    setBulkBusy(true);
    try {
      const blob = await downloadEmployeeCredentials();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `employee-credentials-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBulkResult((prev) => (prev ? { ...prev, downloaded: true } : prev));
      toast.success('فایل اعتبارنامه‌های اولیه دانلود و از حافظهٔ سرور پاک شد.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const copySecret = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('در حافظهٔ موقت کپی شد.');
    } catch {
      toast.error('امکان کپی خودکار در این مرورگر وجود ندارد.');
    }
  };

  const rows = data?.employees ?? [];

  return (
    <>
      <PageHeader
        title="مدیریت کارمندان، اعضای هیئت علمی و پیمانکاران"
        subtitle="ایجاد، ویرایش، غیرفعال‌سازی، بازنشانی رمز عبور و واردسازی گروهی با خروجی یک‌بارمصرف اعتبارنامه‌های اولیه"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setBulkResult(null);
                setBulkOpen(true);
              }}
            >
              <FileSpreadsheet className="ms-1.5 h-4 w-4" />
              واردسازی گروهی (Excel)
            </Button>
            <Button onClick={() => setForm({ ...EMPTY_FORM })}>
              <Plus className="ms-1.5 h-4 w-4" />
              کارمند / استاد جدید
            </Button>
          </div>
        }
      />

      <Section className="mb-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              className="pr-9"
              placeholder="جستجوی نام کاربری، نام، واحد یا کد پرسنلی…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger>
              <SelectValue placeholder="گروه تعرفه‌ای" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>همهٔ گروه‌ها</SelectItem>
              <SelectItem value="Employee">{GROUP_LABELS.Employee}</SelectItem>
              <SelectItem value="Faculty">{GROUP_LABELS.Faculty}</SelectItem>
              <SelectItem value="Contractor">{GROUP_LABELS.Contractor}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="وضعیت حساب" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>همهٔ وضعیت‌ها</SelectItem>
              <SelectItem value="Active">فعال</SelectItem>
              <SelectItem value="Disabled">غیرفعال</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Section>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="حسابی در این بخش ثبت نشده است"
          text="می‌توانید به صورت تکی یا با بارگذاری فایل اکسل تا ۳۰۰ ردیف، حساب کارمندان و اساتید را ایجاد کنید."
        />
      ) : (
        <Section title={`فهرست حساب‌ها (${faNum(data?.total ?? rows.length)})`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">نام کاربری</TableHead>
                  <TableHead className="text-right">نام و نام خانوادگی</TableHead>
                  <TableHead className="text-right">گروه تعرفه</TableHead>
                  <TableHead className="hidden text-right md:table-cell">واحد / کد پرسنلی</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">اعتبار کیف پول</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">آخرین ورود</TableHead>
                  <TableHead className="text-right">وضعیت</TableHead>
                  <TableHead className="text-left">عملیات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      {r.username}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div>{r.fullName}</div>
                      {r.mobile && <div className="num text-xs text-muted-foreground">{r.mobile}</div>}
                    </TableCell>
                    <TableCell>
                      <Pill tone={r.customerGroup === 'Faculty' ? 'info' : 'muted'}>
                        {GROUP_LABELS[r.customerGroup] ?? r.customerGroup}
                      </Pill>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      <div>{r.department || '—'}</div>
                      {r.personnelCode && <div className="num">کد: {r.personnelCode}</div>}
                    </TableCell>
                    <TableCell className="num hidden text-xs lg:table-cell">{rial(r.balanceRial)}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {r.lastLoginAt ? faDateTime(r.lastLoginAt) : 'بدون ورود'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Pill tone={r.status === 'Active' ? 'success' : 'danger'}>
                          {r.status === 'Active' ? 'فعال' : 'غیرفعال'}
                        </Pill>
                        {r.mustChangePassword && <Pill tone="warning">نیازمند تغییر رمز</Pill>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)} title="ویرایش">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setCustomResetPassword('');
                            setResetTarget(r);
                          }}
                          title="ریست رمز عبور"
                        >
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void handleToggleStatus(r)}
                          title={r.status === 'Active' ? 'غیرفعال‌سازی حساب' : 'فعال‌سازی حساب'}
                        >
                          {r.status === 'Active' ? (
                            <Ban className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-[hsl(var(--success))]" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}

      {/* دیالوگ ایجاد / ویرایش کارمند */}
      <Dialog open={!!form} onOpenChange={(o) => !o && !busy && setForm(null)}>
        <DialogContent dir="rtl" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form?.id ? 'ویرایش حساب کارمند / استاد' : 'ایجاد حساب کارمند / استاد جدید'}</DialogTitle>
            <DialogDescription>
              در صورت خالی گذاشتن رمز عبور هنگام ساخت حساب جدید، سامانه یک رمز تصادفی امن تولید و فقط یک‌بار به شما نمایش می‌دهد.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-3 py-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="emp-username">نام کاربری (انگلیسی / عددی)</Label>
                <Input
                  id="emp-username"
                  dir="ltr"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="e.g. ahmadi_hr"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emp-fullname">نام و نام خانوادگی</Label>
                <Input
                  id="emp-fullname"
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  placeholder="دکتر علی احمدی"
                />
              </div>
              <div className="space-y-1.5">
                <Label>گروه تعرفهٔ مشتری</Label>
                <Select
                  value={form.customerGroup}
                  onValueChange={(v) => setForm({ ...form, customerGroup: v as EmployeeForm['customerGroup'] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Employee">{GROUP_LABELS.Employee}</SelectItem>
                    <SelectItem value="Faculty">{GROUP_LABELS.Faculty}</SelectItem>
                    <SelectItem value="Contractor">{GROUP_LABELS.Contractor}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>وضعیت حساب</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: v as EmployeeForm['status'] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">فعال</SelectItem>
                    <SelectItem value="Disabled">غیرفعال (ابطال نشست‌ها)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emp-dept">دانشکده / واحد سازمانی</Label>
                <Input
                  id="emp-dept"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  placeholder="مثلاً آموزش کل"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emp-pcode">کد پرسنلی (اختیاری)</Label>
                <Input
                  id="emp-pcode"
                  dir="ltr"
                  value={form.personnelCode}
                  onChange={(e) => setForm({ ...form, personnelCode: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emp-mobile">شماره موبایل (اختیاری — برای یادآوری وعده)</Label>
                <Input
                  id="emp-mobile"
                  dir="ltr"
                  value={form.mobile}
                  onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                  placeholder="0911..."
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="emp-last4">۴ رقم آخر کد ملی (اختیاری)</Label>
                <Input
                  id="emp-last4"
                  dir="ltr"
                  maxLength={4}
                  value={form.nationalIdLast4}
                  onChange={(e) => setForm({ ...form, nationalIdLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                  placeholder="1234"
                />
              </div>
              {!form.id && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="emp-password">رمز عبور اولیه (اختیاری — خالی بگذارید تا خودکار تولید شود)</Label>
                  <Input
                    id="emp-password"
                    type="password"
                    dir="ltr"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="حداقل ۱۰ کاراکتر در صورت تعیین دستی"
                  />
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setForm(null)} disabled={busy}>
              انصراف
            </Button>
            <Button onClick={() => void handleSave()} disabled={!formValid || busy}>
              {busy && <Loader2 className="ms-1.5 h-4 w-4 animate-spin" />}
              ذخیره
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ ریست رمز عبور */}
      <Dialog open={!!resetTarget} onOpenChange={(o) => !o && !busy && setResetTarget(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>بازنشانی رمز عبور {resetTarget?.fullName}</DialogTitle>
            <DialogDescription>
              با بازنشانی رمز، تمام نشست‌های فعال این کاربر بلافاصله باطل شده و در اولین ورود ملزم به تغییر رمز عبور خواهد بود.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="emp-reset-pass">رمز جدید سفارشی (اختیاری — در صورت خالی بودن، رمز موقت تصادفی ساخته می‌شود)</Label>
            <Input
              id="emp-reset-pass"
              type="password"
              dir="ltr"
              value={customResetPassword}
              onChange={(e) => setCustomResetPassword(e.target.value)}
              placeholder="خالی = تولید خودکار رمز یک‌بارمصرف"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={busy}>
              انصراف
            </Button>
            <Button onClick={() => void handleResetPassword()} disabled={busy}>
              {busy && <Loader2 className="ms-1.5 h-4 w-4 animate-spin" />}
              تأیید و صدور رمز موقت
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ نمایش یک‌بارمصرف رمز عبور موقت */}
      <Dialog open={!!oneTimeSecret} onOpenChange={(o) => !o && setOneTimeSecret(null)}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[hsl(var(--warning))]">
              <ShieldAlert className="h-5 w-5" />
              اعتبارنامهٔ اولیهٔ یک‌بارمصرف
            </DialogTitle>
            <DialogDescription>
              این رمز عبور در سرور فقط به‌صورت هش `Argon2id` ذخیره شده است و پس از بستن این پنجره دیگر قابل بازیابی نیست.
            </DialogDescription>
          </DialogHeader>
          {oneTimeSecret && (
            <div className="space-y-3 rounded-2xl border bg-muted/40 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">نام و نام خانوادگی:</span>
                <strong>{oneTimeSecret.fullName}</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">نام کاربری:</span>
                <code dir="ltr" className="font-mono font-bold">
                  {oneTimeSecret.username}
                </code>
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <span className="text-muted-foreground">رمز عبور موقت:</span>
                <div className="flex items-center gap-2">
                  <code dir="ltr" className="rounded bg-card px-2.5 py-1 font-mono text-base font-extrabold">
                    {oneTimeSecret.temporaryPassword}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copySecret(oneTimeSecret.temporaryPassword)}
                  >
                    <Copy className="ms-1 h-3.5 w-3.5" />
                    کپی
                  </Button>
                </div>
              </div>
              {oneTimeSecret.sessionsRevoked != null && (
                <p className="text-xs text-muted-foreground">
                  تعداد نشست‌های فعال باطل‌شده: {faNum(oneTimeSecret.sessionsRevoked)}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setOneTimeSecret(null)}>یادداشت کردم، بستن</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ واردسازی گروهی اکسل + دانلود یک‌بارمصرف اعتبارنامه‌ها */}
      <Dialog open={bulkOpen} onOpenChange={(o) => !o && !bulkBusy && setBulkOpen(false)}>
        <DialogContent dir="rtl" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>واردسازی گروهی کارمندان و اساتید (حداکثر ۳۰۰ ردیف)</DialogTitle>
            <DialogDescription>
              ستون‌های شیت اول فایل `.xlsx` به ترتیب: ۱) نام کاربری ۲) نام و نام خانوادگی ۳) گروه (`کارمند` / `هیئت علمی` / `پیمانکار`) ۴) واحد سازمانی ۵) موبایل.
            </DialogDescription>
          </DialogHeader>

          {!bulkResult ? (
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition hover:border-primary/60 hover:bg-secondary/30">
              {bulkBusy ? (
                <Loader2 className="h-9 w-9 animate-spin text-primary" />
              ) : (
                <Upload className="h-9 w-9 text-primary" />
              )}
              <span className="mt-3 text-sm font-semibold">
                {bulkBusy ? 'در حال ساخت حساب‌ها و تولید رمزهای تصادفی…' : 'انتخاب فایل اکسل (.xlsx)'}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">ردیف اول به عنوان سرستون نادیده گرفته می‌شود</span>
              <input
                type="file"
                accept=".xlsx"
                className="sr-only"
                disabled={bulkBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  void handleBulkUpload(f);
                }}
              />
            </label>
          ) : (
            <div className="space-y-4 py-2">
              <div className="rounded-2xl border bg-muted/40 p-4 text-sm">
                <p className="font-bold">
                  {faNum(bulkResult.created)} حساب جدید ایجاد شد · {faNum(bulkResult.skipped)} ردیف تکراری/نامعتبر رد شد.
                </p>
              </div>
              {bulkResult.created > 0 && (
                <div className="rounded-2xl border-2 border-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)] p-4 text-sm">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--warning))]" />
                    <div className="space-y-2">
                      <p className="font-bold">فایل اعتبارنامه‌های اولیه فقط یک بار و تا ۱۰ دقیقه قابل دانلود است!</p>
                      <p className="text-xs text-muted-foreground">
                        به محض دانلود، فایل حاوی رمزهای موقت برای همیشه از حافظهٔ سرور پاک می‌شود.
                      </p>
                      <Button
                        onClick={() => void handleDownloadOneTimeCredentials()}
                        disabled={bulkBusy || bulkResult.downloaded}
                        className="mt-2 w-full"
                      >
                        {bulkBusy ? (
                          <Loader2 className="ms-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="ms-1.5 h-4 w-4" />
                        )}
                        {bulkResult.downloaded
                          ? 'فایل اعتبارنامه دانلود و از سرور پاک شد'
                          : 'دانلود یک‌بارمصرف فایل اعتبارنامه‌های اولیه (.xlsx)'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>
              بستن
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
