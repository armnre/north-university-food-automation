import { describe, expect, it } from 'vitest';
import {
  addDays,
  canManageStaffRole,
  formatFaDate,
  formatFaDateTime,
  hasPermission,
  isPastServiceDate,
  MANAGEABLE_STAFF_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  tehranDateTimeToUtc,
  tehranOffsetMinutes,
  tehranParts,
  tehranToday,
} from '../src/index.js';

describe('زمان تهران', () => {
  it('اختلاف تهران با UTC دقیقاً ۳:۳۰ است (بدون DST)', () => {
    expect(tehranOffsetMinutes(new Date('2026-03-21T00:00:00Z'))).toBe(210);
    expect(tehranOffsetMinutes(new Date('2026-07-01T12:00:00Z'))).toBe(210);
  });

  it('روز سرویس و اجزای زمان به وقت تهران محاسبه می‌شود', () => {
    // ۲۲:۰۰ UTC = ۰۱:۳۰ روز بعد در تهران
    const lateUtc = new Date('2026-01-01T22:00:00Z');
    expect(tehranToday(lateUtc)).toBe('2026-01-02');
    const parts = tehranParts(lateUtc);
    expect(parts.hour).toBe(1);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(2);
  });

  it('ترکیب روز سرویس با ساعت دیواری تهران ⇒ لحظهٔ UTC درست', () => {
    const utc = tehranDateTimeToUtc('2026-01-02', '12:00');
    expect(utc.toISOString()).toBe('2026-01-02T08:30:00.000Z');
    const early = tehranDateTimeToUtc('2026-01-02', '00:00');
    expect(early.toISOString()).toBe('2026-01-01T20:30:00.000Z');
  });

  it('جمع روز به روز سرویس بدون جابه‌جایی منطقهٔ زمانی', () => {
    expect(addDays('2026-03-20', 1)).toBe('2026-03-21');
    expect(addDays('2026-03-20', -1)).toBe('2026-03-19');
    expect(isPastServiceDate('2000-01-01')).toBe(true);
    expect(isPastServiceDate(addDays(tehranToday(), 1))).toBe(false);
  });

  it('نمایش شمسی برای پیام‌های مهلت', () => {
    expect(formatFaDate('2026-01-02')).toMatch(/۱۴۰۴|۱۴۰۵/);
    expect(formatFaDateTime('2026-01-02T08:30:00Z')).toContain('ساعت');
    expect(formatFaDate(null)).toBe('—');
  });
});

describe('ماتریس RBAC', () => {
  it('همهٔ مجوزهای هر نقش در فهرست مجوزهای معتبر هستند', () => {
    for (const role of STAFF_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('تفکیک وظایف: مدیر ارشد financeWrite ندارد و فقط امور مالی دارد', () => {
    expect(hasPermission('SuperAdmin', 'financeWrite')).toBe(false);
    expect(hasPermission('Finance', 'financeWrite')).toBe(true);
    expect(hasPermission('Finance', 'settings')).toBe(false);
    expect(hasPermission('Finance', 'audit')).toBe(false);
  });

  it('audit/settings/users فقط برای مدیر ارشد است', () => {
    for (const role of STAFF_ROLES.filter((r) => r !== 'SuperAdmin')) {
      expect(hasPermission(role, 'audit'), role).toBe(false);
      expect(hasPermission(role, 'settings'), role).toBe(false);
      expect(hasPermission(role, 'users'), role).toBe(false);
    }
    expect(hasPermission('SuperAdmin', 'audit')).toBe(true);
    expect(hasPermission('SuperAdmin', 'settings')).toBe(true);
    expect(hasPermission('SuperAdmin', 'users')).toBe(true);
  });

  it('اپراتور فقط تحویل سلف خود و پیمانکار فقط گزارش محدود دارد', () => {
    expect(ROLE_PERMISSIONS.Operator).toEqual(['delivery']);
    expect(ROLE_PERMISSIONS.Contractor).toEqual(['contractorReports']);
    expect(hasPermission('Operator', 'deliveryAll')).toBe(false);
    expect(hasPermission('SuperAdmin', 'deliveryAll')).toBe(true);
  });

  it('هیچ نقشی حساب هم‌سطح یا بالاتر را مدیریت نمی‌کند', () => {
    for (const actor of STAFF_ROLES) {
      for (const target of MANAGEABLE_STAFF_ROLES[actor]) {
        expect(canManageStaffRole(actor, target), `${actor} → ${target}`).toBe(true);
      }
      expect(canManageStaffRole(actor, actor), `هم‌سطح ${actor}`).toBe(false);
      expect(canManageStaffRole(actor, 'SuperAdmin'), `${actor} → SuperAdmin`).toBe(false);
    }
    expect(canManageStaffRole('NutritionManager', 'Operator')).toBe(true);
    expect(canManageStaffRole('NutritionManager', 'StudentAffairs')).toBe(false);
    expect(canManageStaffRole('StudentAffairs', 'Operator')).toBe(false);
    expect(canManageStaffRole('Finance', 'Operator')).toBe(false);
  });
});
