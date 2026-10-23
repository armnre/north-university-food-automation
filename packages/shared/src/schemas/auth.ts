import { z } from 'zod';
import { EMPLOYEE_STATUSES, STAFF_ROLES, STAFF_STATUSES, STUDENT_STATUSES } from '../constants.js';
import { PERMISSIONS } from '../permissions.js';

/** قراردادهای احراز هویت، نشست و مدیریت رمز. */

/** فیلدهای اختیاری کپچا — از تلاش سوم اجباری می‌شوند. */
export const captchaFieldsSchema = z.object({
  captchaId: z.uuid().optional(),
  captchaAnswer: z.string().min(1).max(20).optional(),
});

export const studentLoginRequestSchema = captchaFieldsSchema.extend({
  studentNumber: z.string().min(1, 'شماره دانشجویی را وارد کنید.').max(20),
  nationalId: z.string().min(1, 'کد ملی را وارد کنید.').max(20),
});

export const passwordLoginRequestSchema = captchaFieldsSchema.extend({
  username: z.string().min(1, 'نام کاربری را وارد کنید.').max(64),
  password: z.string().min(1, 'رمز عبور را وارد کنید.').max(200),
});

/**
 * پاسخ ورود موفق. توکن در کوکی HttpOnly تنظیم می‌شود و **هرگز** در بدنهٔ
 * پاسخ برنمی‌گردد (حذف کامل sessionStorage از فرانت‌اند).
 */
export const loginResponseSchema = z.object({
  ok: z.literal(true),
  kind: z.enum(['student', 'employee', 'staff']),
  mustChangePassword: z.boolean(),
  newDevice: z.boolean(),
  message: z.string().optional(),
});

export const captchaResponseSchema = z.object({
  captchaId: z.uuid(),
  kind: z.enum(['Math', 'Text']),
  /** تصویر SVG کپچا (ساخت خود سامانه؛ بدون وابستگی بیرونی). */
  imageSvg: z.string(),
  expiresAt: z.string(),
  required: z.boolean(),
});

export const sessionItemSchema = z.object({
  id: z.uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});

export const sessionsListResponseSchema = z.object({ sessions: z.array(sessionItemSchema) });

export const revokeSessionRequestSchema = z.object({ sessionId: z.uuid() });

export const studentMeSchema = z.object({
  id: z.uuid(),
  studentNumber: z.string(),
  fullName: z.string(),
  faculty: z.string(),
  major: z.string(),
  degree: z.string(),
  entryYear: z.number().int().nullable(),
  nationalIdMasked: z.string(),
  status: z.enum(STUDENT_STATUSES),
  balanceRial: z.number().int(),
  customerGroup: z.literal('Student'),
});

export const employeeMeSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  department: z.string(),
  mobile: z.string().nullable(),
  customerGroup: z.enum(['Employee', 'Faculty', 'Contractor']),
  status: z.enum(EMPLOYEE_STATUSES),
  balanceRial: z.number().int(),
  accountId: z.uuid(),
});

export const staffMeSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  role: z.enum(STAFF_ROLES),
  status: z.enum(STAFF_STATUSES),
  permissions: z.array(z.enum(PERMISSIONS)),
  contractorId: z.uuid().nullable(),
  cafeteriaId: z.uuid().nullable(),
  mustChangePassword: z.boolean(),
});

export const meResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('student'), student: studentMeSchema }),
  z.object({ kind: z.literal('employee'), employee: employeeMeSchema }),
  z.object({ kind: z.literal('staff'), staff: staffMeSchema }),
]);

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'رمز جدید باید حداقل ۱۰ کاراکتر باشد.').max(200),
});

export const setupStatusResponseSchema = z.object({
  needsSetup: z.boolean(),
  setupCodeConfigured: z.boolean(),
});

export const setupAdminRequestSchema = z.object({
  setupCode: z.string().min(1, 'کد راه‌اندازی را وارد کنید.').max(200),
  username: z.string().min(3).max(64),
  fullName: z.string().min(2).max(100),
  password: z.string().min(10, 'رمز عبور باید حداقل ۱۰ کاراکتر باشد.').max(200),
});

export const logoutResponseSchema = z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() });
