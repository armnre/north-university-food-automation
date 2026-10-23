import { eq } from 'drizzle-orm';
import {
  type EmployeeStatus,
  isStrongEnoughPassword,
  isValidNationalId,
  normalizeDigits,
  normalizeUsername,
  permissionsOf,
  type StaffRole,
  type StaffStatus,
  type StudentStatus,
} from '@food/shared';
import { employees, staffUsers, students } from '../db/schema/index.js';
import { hashPassword, hmacSha256Hex, passwordNeedsRehash, safeEqual, sha256Hex, verifyPassword } from '../lib/crypto.js';
import { rawSql } from '../db/raw.js';
import { isLikelyNewDevice } from '../lib/request-context.js';
import { AppError, fail } from '../lib/errors.js';
import type { AuthContext, ServiceDeps } from '../types.js';
import { writeAudit } from './audit.service.js';
import { ensureEmployeeAccount, ensureStudentAccount } from './account.service.js';
import { enforceLoginThrottle, recordLoginFailure, recordLoginSuccess } from './login-throttle.service.js';
import {
  createSession,
  findValidSession,
  listRecentUserAgents,
  revokeAllSessionsForSubject,
  revokeOtherSessions,
  revokeSessionByToken,
  touchSession,
} from './session.service.js';
import { createNotification } from './notification.service.js';

/**
 * احراز هویت.
 *
 * تصمیم‌های امنیتی پیاده‌سازی‌شده:
 *  - ورود دانشجو: شمارهٔ دانشجویی + کد ملی **بدون رمز** (تصمیم صاحب پروژه).
 *    کد ملی فقط با HMAC-SHA256 + pepper مقایسه می‌شود (timing-safe) و
 *    رقم کنترلی آن اعتبارسنجی می‌شود. ریسک باقی‌مانده در docs/SECURITY.md ثبت شده است.
 *  - ورود کارکنان/کارمندان: Argon2id. برای نام کاربری ناموجود هم `verify`
 *    روی hash ساختگی اجرا می‌شود تا زمان پاسخ یکسان بماند.
 *  - پیام خطای ورود هرگز وجود/عدم وجود حساب یا درستی کد ملی را لو نمی‌دهد.
 *  - محدودیت تلاش و کپچا بر پایهٔ (شناسه + IP) — شامل شناسه‌های ناموجود.
 */

const GENERIC_STUDENT_LOGIN_ERROR = 'شمارهٔ دانشجویی یا کد ملی صحیح نیست.';
const GENERIC_PASSWORD_LOGIN_ERROR = 'نام کاربری یا رمز عبور صحیح نیست.';

export type LoginRequestMeta = { ip: string; userAgent?: string; captchaId?: string | null; captchaAnswer?: string | null };

export type LoginResult = {
  token: string;
  sessionId: string;
  kind: 'student' | 'employee' | 'staff';
  mustChangePassword: boolean;
  newDevice: boolean;
};

/** ورود دانشجو با شمارهٔ دانشجویی و کد ملی. */
export async function loginStudent(
  deps: ServiceDeps,
  input: { studentNumber: string; nationalId: string } & LoginRequestMeta,
): Promise<LoginResult> {
  const studentNumber = normalizeDigits(input.studentNumber);
  const nationalId = normalizeDigits(input.nationalId);

  if (!/^\d{5,15}$/.test(studentNumber) || !/^\d{10}$/.test(nationalId)) {
    fail('VALIDATION', 'شمارهٔ دانشجویی و کد ملی را کامل و صحیح وارد کنید.');
  }

  await enforceLoginThrottle(deps, {
    subjectType: 'Student',
    identifier: studentNumber,
    ip: input.ip,
    captchaId: input.captchaId,
    captchaAnswer: input.captchaAnswer,
  });

  const rows = await deps.db.select().from(students).where(eq(students.studentNumber, studentNumber)).limit(1);
  const student = rows[0];

  const expectedHash = hmacSha256Hex(deps.env.NATIONAL_ID_PEPPER, nationalId);
  const storedHash = student?.nationalIdHash ?? hmacSha256Hex(deps.env.NATIONAL_ID_PEPPER, `invalid:${studentNumber}`);
  const hashMatches = safeEqual(expectedHash, storedHash);
  const checksumOk = isValidNationalId(nationalId);
  const credentialsOk = !!student && hashMatches && checksumOk;

  if (!credentialsOk) {
    await recordLoginFailure(deps, { subjectType: 'Student', identifier: studentNumber, ip: input.ip });
    await writeAudit(deps.db, {
      actor: { type: 'Anonymous', id: '', label: '' },
      action: 'auth.student.failed',
      targetType: 'StudentNumberHash',
      targetId: hmacSha256Hex(deps.env.CSRF_SECRET, studentNumber).slice(0, 16),
      details: { reason: !student ? 'not_found' : !checksumOk ? 'bad_checksum' : 'hash_mismatch' },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new AppError('UNAUTHORIZED', GENERIC_STUDENT_LOGIN_ERROR);
  }

  if (student!.status !== 'Active') {
    // پس از احراز هویت صحیح، اعلام غیرفعال بودن حساب مجاز است (بدون افشای جزئیات بیشتر)
    await writeAudit(deps.db, {
      actor: { type: 'Student', id: student!.id, label: studentNumber },
      action: 'auth.student.inactive',
      targetType: 'Student',
      targetId: student!.id,
      details: { status: student!.status },
      ip: input.ip,
    });
    throw new AppError('ACCOUNT_INACTIVE', 'حساب شما فعال نیست. برای پیگیری با معاونت دانشجویی تماس بگیرید.');
  }

  const accountId = await ensureStudentAccount(deps.db, student!.id);
  await recordLoginSuccess(deps, { subjectType: 'Student', identifier: studentNumber, ip: input.ip });

  const previousUserAgents = await listRecentUserAgents(deps, 'Student', student!.id);
  const newDevice = isLikelyNewDevice(previousUserAgents, input.userAgent ?? '');

  const session = await createSession(deps.db, deps, {
    subjectType: 'Student',
    subjectId: student!.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await deps.db.update(students).set({ lastLoginAt: new Date() }).where(eq(students.id, student!.id));

  await writeAudit(deps.db, {
    actor: { type: 'Student', id: student!.id, label: studentNumber },
    action: 'auth.student.success',
    targetType: 'Student',
    targetId: student!.id,
    details: { newDevice },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  // کاهش ریسک «ورود بدون رمز»: اطلاع‌رسانی ورود از دستگاه جدید
  if (newDevice && previousUserAgents.length > 0) {
    await createNotification(deps.db, {
      title: 'ورود از دستگاه جدید',
      body: `ورود به حساب شما از یک دستگاه یا مرورگر جدید (IP: ${input.ip || 'نامشخص'}) ثبت شد. اگر این ورود توسط شما انجام نشده است، از بخش پروفایل سایر نشست‌ها را باطل کرده و فوراً به معاونت دانشجویی اطلاع دهید.`,
      audience: 'Account',
      accountId,
      event: 'security.new_login',
    });
  }

  return { token: session.token, sessionId: session.sessionId, kind: 'student', mustChangePassword: false, newDevice };
}

/** ورود کارکنان سامانه (username + password). */
export async function loginStaff(
  deps: ServiceDeps,
  input: { username: string; password: string } & LoginRequestMeta,
): Promise<LoginResult> {
  const username = normalizeUsername(input.username);
  if (!username || !input.password) fail('VALIDATION', 'نام کاربری و رمز عبور را وارد کنید.');

  await enforceLoginThrottle(deps, {
    subjectType: 'Staff',
    identifier: username,
    ip: input.ip,
    captchaId: input.captchaId,
    captchaAnswer: input.captchaAnswer,
  });

  const rows = await deps.db.select().from(staffUsers).where(eq(staffUsers.username, username)).limit(1);
  const user = rows[0];
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? null);

  if (!user || !passwordOk) {
    await recordLoginFailure(deps, { subjectType: 'Staff', identifier: username, ip: input.ip });
    await writeAudit(deps.db, {
      actor: { type: 'Anonymous', id: '', label: username.slice(0, 64) },
      action: 'auth.staff.failed',
      targetType: 'StaffUser',
      targetId: user?.id ?? '',
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new AppError('UNAUTHORIZED', GENERIC_PASSWORD_LOGIN_ERROR);
  }

  if (user.status !== 'Active') {
    throw new AppError('ACCOUNT_INACTIVE', 'حساب کاربری شما غیرفعال است. با مدیر سامانه تماس بگیرید.');
  }

  // مهاجرت رمز قدیمی PBKDF2 → Argon2id در اولین ورود موفق
  if (passwordNeedsRehash(user.passwordHash)) {
    await deps.db
      .update(staffUsers)
      .set({ passwordHash: await hashPassword(input.password), passwordChangedAt: new Date() })
      .where(eq(staffUsers.id, user.id));
    await writeAudit(deps.db, {
      actor: { type: 'Staff', id: user.id, label: user.username },
      action: 'auth.password.rehashed',
      targetType: 'StaffUser',
      targetId: user.id,
      details: { from: user.passwordHash.startsWith('pbkdf2$') ? 'pbkdf2' : 'argon2-params' },
      ip: input.ip,
    });
  }

  await recordLoginSuccess(deps, { subjectType: 'Staff', identifier: username, ip: input.ip });
  const session = await createSession(deps.db, deps, {
    subjectType: 'Staff',
    subjectId: user.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await deps.db.update(staffUsers).set({ lastLoginAt: new Date() }).where(eq(staffUsers.id, user.id));
  await writeAudit(deps.db, {
    actor: { type: 'Staff', id: user.id, label: user.fullName || user.username },
    action: 'auth.staff.success',
    targetType: 'StaffUser',
    targetId: user.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    token: session.token,
    sessionId: session.sessionId,
    kind: 'staff',
    mustChangePassword: user.mustChangePassword,
    newDevice: false,
  };
}

/** ورود کارمند/هیئت‌علمی/پیمانکار دانشگاه (مشتری سلف). */
export async function loginEmployee(
  deps: ServiceDeps,
  input: { username: string; password: string } & LoginRequestMeta,
): Promise<LoginResult> {
  const username = normalizeUsername(input.username);
  if (!username || !input.password) fail('VALIDATION', 'نام کاربری و رمز عبور را وارد کنید.');

  await enforceLoginThrottle(deps, {
    subjectType: 'Employee',
    identifier: username,
    ip: input.ip,
    captchaId: input.captchaId,
    captchaAnswer: input.captchaAnswer,
  });

  const rows = await deps.db.select().from(employees).where(eq(employees.username, username)).limit(1);
  const employee = rows[0];
  const passwordOk = await verifyPassword(input.password, employee?.passwordHash ?? null);

  if (!employee || !passwordOk) {
    await recordLoginFailure(deps, { subjectType: 'Employee', identifier: username, ip: input.ip });
    await writeAudit(deps.db, {
      actor: { type: 'Anonymous', id: '', label: username.slice(0, 64) },
      action: 'auth.employee.failed',
      targetType: 'Employee',
      targetId: employee?.id ?? '',
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new AppError('UNAUTHORIZED', GENERIC_PASSWORD_LOGIN_ERROR);
  }

  if (employee.status !== 'Active') {
    throw new AppError('ACCOUNT_INACTIVE', 'حساب کاربری شما غیرفعال است. با معاونت دانشجویی تماس بگیرید.');
  }

  if (passwordNeedsRehash(employee.passwordHash)) {
    await deps.db
      .update(employees)
      .set({ passwordHash: await hashPassword(input.password), passwordChangedAt: new Date() })
      .where(eq(employees.id, employee.id));
  }

  await ensureEmployeeAccount(deps.db, employee.id, employee.customerGroup as 'Employee' | 'Faculty' | 'Contractor');
  await recordLoginSuccess(deps, { subjectType: 'Employee', identifier: username, ip: input.ip });
  const session = await createSession(deps.db, deps, {
    subjectType: 'Employee',
    subjectId: employee.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await deps.db.update(employees).set({ lastLoginAt: new Date() }).where(eq(employees.id, employee.id));
  await writeAudit(deps.db, {
    actor: { type: 'Employee', id: employee.id, label: employee.fullName || employee.username },
    action: 'auth.employee.success',
    targetType: 'Employee',
    targetId: employee.id,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    token: session.token,
    sessionId: session.sessionId,
    kind: 'employee',
    mustChangePassword: employee.mustChangePassword,
    newDevice: false,
  };
}

/** ساخت `AuthContext` از توکن نشست در یک پرس‌وجوی ایندکس‌شدهٔ واحد؛ اگر نامعتبر باشد `null`. */
export async function resolveAuthContext(deps: ServiceDeps, token: string, options?: { touch?: boolean }): Promise<AuthContext | null> {
  if (!token || token.length < 32) return null;
  const tokenHash = sha256Hex(token);
  const res = await deps.db.execute(
    rawSql(
      `SELECT sess.id AS "sessionId", sess.subject_type AS "subjectType", sess.subject_id AS "subjectId",
              sess.expires_at AS "expiresAt", sess.absolute_expires_at AS "absoluteExpiresAt", sess.last_seen_at AS "lastSeenAt",
              st.id AS "studentId", st.student_number AS "studentNumber", st.full_name AS "studentName",
              st.faculty, st.major, st.degree, st.entry_year AS "entryYear",
              st.national_id_last4 AS "nationalIdLast4", st.status AS "studentStatus", st.last_login_at AS "studentLastLoginAt",
              em.id AS "employeeId", em.username AS "employeeUsername", em.full_name AS "employeeName",
              em.department, em.customer_group AS "employeeGroup", em.status AS "employeeStatus",
              em.must_change_password AS "employeeMustChange",
              su.id AS "staffId", su.username AS "staffUsername", su.full_name AS "staffName",
              su.role AS "staffRole", su.status AS "staffStatus", su.contractor_id AS "contractorId",
              su.cafeteria_id AS "cafeteriaId", su.must_change_password AS "staffMustChange",
              ac.id AS "accountId", ac.balance_rial::text AS "balanceRial", ac.is_active AS "accountIsActive"
       FROM sessions sess
       LEFT JOIN students st ON sess.subject_type = 'Student' AND st.id = sess.subject_id
       LEFT JOIN employees em ON sess.subject_type = 'Employee' AND em.id = sess.subject_id
       LEFT JOIN staff_users su ON sess.subject_type = 'Staff' AND su.id = sess.subject_id
       LEFT JOIN accounts ac ON (sess.subject_type = 'Student' AND ac.student_id = st.id)
                             OR (sess.subject_type = 'Employee' AND ac.employee_id = em.id)
       WHERE sess.token_hash = $1
         AND sess.revoked_at IS NULL
         AND sess.expires_at > now()
         AND sess.absolute_expires_at > now()
       LIMIT 1`,
      [tokenHash],
    ),
  );
  const row = ((res as unknown as { rows: Record<string, unknown>[] }).rows ?? [])[0];
  if (!row) return null;

  const subjectType = String(row.subjectType);
  let ctx: AuthContext;

  if (subjectType === 'Student') {
    if (!row.studentId || String(row.studentStatus) !== 'Active') return null;
    if (!row.accountId || !row.accountIsActive) return null;
    ctx = {
      kind: 'student',
      subjectType: 'Student',
      sessionId: String(row.sessionId),
      studentId: String(row.studentId),
      accountId: String(row.accountId),
      studentNumber: String(row.studentNumber),
      fullName: String(row.studentName),
      faculty: String(row.faculty ?? ''),
      major: String(row.major ?? ''),
      degree: String(row.degree ?? ''),
      entryYear: row.entryYear == null ? null : Number(row.entryYear),
      nationalIdLast4: String(row.nationalIdLast4 ?? ''),
      status: String(row.studentStatus) as StudentStatus,
      customerGroup: 'Student',
      balanceRial: Number(row.balanceRial ?? 0),
      lastLoginAt:
        row.studentLastLoginAt instanceof Date
          ? row.studentLastLoginAt
          : row.studentLastLoginAt
            ? new Date(String(row.studentLastLoginAt))
            : null,
    };
  } else if (subjectType === 'Employee') {
    if (!row.employeeId || String(row.employeeStatus) !== 'Active') return null;
    if (!row.accountId || !row.accountIsActive) return null;
    ctx = {
      kind: 'employee',
      subjectType: 'Employee',
      sessionId: String(row.sessionId),
      employeeId: String(row.employeeId),
      accountId: String(row.accountId),
      username: String(row.employeeUsername),
      fullName: String(row.employeeName),
      department: String(row.department ?? ''),
      customerGroup: String(row.employeeGroup) as 'Employee' | 'Faculty' | 'Contractor',
      status: String(row.employeeStatus) as EmployeeStatus,
      mustChangePassword: Boolean(row.employeeMustChange),
      balanceRial: Number(row.balanceRial ?? 0),
    };
  } else {
    if (!row.staffId || String(row.staffStatus) !== 'Active') return null;
    const role = String(row.staffRole) as StaffRole;
    ctx = {
      kind: 'staff',
      subjectType: 'Staff',
      sessionId: String(row.sessionId),
      staffId: String(row.staffId),
      username: String(row.staffUsername),
      fullName: String(row.staffName),
      role,
      permissions: permissionsOf(role),
      status: String(row.staffStatus) as StaffStatus,
      contractorId: row.contractorId == null ? null : String(row.contractorId),
      cafeteriaId: row.cafeteriaId == null ? null : String(row.cafeteriaId),
      mustChangePassword: Boolean(row.staffMustChange),
    };
  }

  if (options?.touch) {
    const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
    const absoluteExpiresAt = row.absoluteExpiresAt instanceof Date ? row.absoluteExpiresAt : new Date(String(row.absoluteExpiresAt));
    const lastSeenAt = row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(String(row.lastSeenAt));
    void touchSession(deps, {
      id: String(row.sessionId),
      subjectType: subjectType as 'Student' | 'Employee' | 'Staff',
      expiresAt,
      absoluteExpiresAt,
      lastSeenAt,
    }).catch(() => undefined);
  }

  return ctx;
}

/** تغییر رمز عبور (کارکنان و کارمندان) + ابطال سایر نشست‌ها. */
export async function changePassword(
  deps: ServiceDeps,
  input: { auth: AuthContext; currentPassword: string; newPassword: string; ip: string; userAgent?: string },
): Promise<{ revokedSessions: number }> {
  const { auth } = input;
  if (auth.kind === 'student') {
    throw new AppError('FORBIDDEN', 'ورود دانشجو بدون رمز عبور است؛ تغییر رمز برای این حساب معنا ندارد.');
  }

  const table = auth.kind === 'staff' ? staffUsers : employees;
  const id = auth.kind === 'staff' ? auth.staffId : auth.employeeId;
  const username = auth.username;

  const rows = await deps.db.select({ passwordHash: table.passwordHash }).from(table).where(eq(table.id, id)).limit(1);
  const current = rows[0]?.passwordHash;
  if (!current || !(await verifyPassword(input.currentPassword, current))) {
    throw new AppError('UNAUTHORIZED', 'رمز عبور فعلی صحیح نیست.');
  }

  if (!isStrongEnoughPassword(input.newPassword, username)) {
    throw new AppError('VALIDATION', 'رمز جدید باید حداقل ۱۰ کاراکتر باشد و با نام کاربری یکسان نباشد.');
  }
  if (input.newPassword === input.currentPassword) {
    throw new AppError('VALIDATION', 'رمز جدید نمی‌تواند با رمز فعلی یکسان باشد.');
  }

  const hashed = await hashPassword(input.newPassword);
  const revoked = await deps.db.transaction(async (tx) => {
    await tx.update(table).set({ passwordHash: hashed, mustChangePassword: false, passwordChangedAt: new Date() }).where(eq(table.id, id));
    const count = await revokeOtherSessions(tx, auth.subjectType, id, auth.sessionId, 'password_changed');
    await writeAudit(tx, {
      actor: auth.kind === 'staff' ? { type: 'Staff', id, label: username } : { type: 'Employee', id, label: username },
      action: 'auth.password.changed',
      targetType: auth.kind === 'staff' ? 'StaffUser' : 'Employee',
      targetId: id,
      details: { revokedSessions: count },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return count;
  });

  return { revokedSessions: revoked };
}

/** آیا هنوز هیچ مدیر ارشدی وجود ندارد (نیاز به راه‌اندازی اولیه)؟ */
export async function setupStatus(deps: ServiceDeps): Promise<{ needsSetup: boolean; setupCodeConfigured: boolean }> {
  const rows = await deps.db.select({ id: staffUsers.id }).from(staffUsers).where(eq(staffUsers.role, 'SuperAdmin')).limit(1);
  return { needsSetup: rows.length === 0, setupCodeConfigured: Boolean(deps.env.SETUP_CODE) };
}

/** ساخت اولین مدیر ارشد با `SETUP_CODE` یک‌بارمصرف. */
export async function setupAdmin(
  deps: ServiceDeps,
  input: { setupCode: string; username: string; fullName: string; password: string; ip: string; userAgent?: string },
): Promise<{ id: string }> {
  if (!deps.env.SETUP_CODE) {
    throw new AppError('FORBIDDEN', 'راه‌اندازی اولیه در این سامانه غیرفعال است.');
  }
  const existing = await deps.db.select({ id: staffUsers.id }).from(staffUsers).where(eq(staffUsers.role, 'SuperAdmin')).limit(1);
  if (existing.length > 0) {
    throw new AppError('FORBIDDEN', 'راه‌اندازی اولیه قبلاً انجام شده است.');
  }
  if (!safeEqual(String(input.setupCode), deps.env.SETUP_CODE)) {
    await writeAudit(deps.db, {
      actor: { type: 'Anonymous', id: '', label: '' },
      action: 'auth.setup.invalid_code',
      targetType: 'System',
      targetId: '',
      ip: input.ip,
    });
    throw new AppError('FORBIDDEN', 'کد راه‌اندازی صحیح نیست.');
  }

  const username = normalizeUsername(input.username);
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new AppError('VALIDATION', 'نام کاربری فقط می‌تواند شامل حروف انگلیسی کوچک، عدد، نقطه، خط تیره و زیرخط باشد.');
  }
  if (!isStrongEnoughPassword(input.password, username)) {
    throw new AppError('VALIDATION', 'رمز عبور باید حداقل ۱۰ کاراکتر باشد و با نام کاربری یکسان نباشد.');
  }

  const [created] = await deps.db
    .insert(staffUsers)
    .values({
      username,
      fullName: input.fullName.trim().slice(0, 200),
      passwordHash: await hashPassword(input.password),
      role: 'SuperAdmin',
      status: 'Active',
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    })
    .onConflictDoNothing({ target: staffUsers.username })
    .returning({ id: staffUsers.id });

  if (!created) throw new AppError('CONFLICT', 'این نام کاربری قبلاً ثبت شده است.');

  await writeAudit(deps.db, {
    actor: { type: 'System', id: '', label: 'setup' },
    action: 'auth.setup.completed',
    targetType: 'StaffUser',
    targetId: created.id,
    details: { username },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { id: created.id };
}

/** خروج از نشست جاری. */
export async function logout(deps: ServiceDeps, token: string, ip: string): Promise<void> {
  const session = await findValidSession(deps, token);
  if (!session) return;
  await revokeSessionByToken(deps, token, 'logout');
  await writeAudit(deps.db, {
    actor: {
      type: session.subjectType === 'Staff' ? 'Staff' : session.subjectType === 'Student' ? 'Student' : 'Employee',
      id: session.subjectId,
      label: '',
    },
    action: 'auth.logout',
    targetType: 'Session',
    targetId: session.id,
    ip,
  });
}

/** خروج از همهٔ نشست‌ها. */
export async function logoutAll(deps: ServiceDeps, auth: AuthContext, ip: string): Promise<number> {
  const subjectId = auth.kind === 'student' ? auth.studentId : auth.kind === 'employee' ? auth.employeeId : auth.staffId;
  const count = await revokeAllSessionsForSubject(deps.db, auth.subjectType, subjectId, 'logout_all');
  await writeAudit(deps.db, {
    actor: { type: auth.kind === 'staff' ? 'Staff' : auth.kind === 'student' ? 'Student' : 'Employee', id: subjectId, label: '' },
    action: 'auth.logout_all',
    targetType: 'Session',
    targetId: subjectId,
    details: { revoked: count },
    ip,
  });
  return count;
}
