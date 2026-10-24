import { describe, expect, it } from 'vitest';
import { isValidNationalId, normalizeDigits, normalizeNationalId, tehranDate, tehranWallToUtc, addDays, hasPermission, canManage, parseRial } from './index.js';

describe('digits & national id', () => {
  it('normalises Persian and Arabic digits', () => expect(normalizeDigits('۰۱۲٣٤ 5-6')).toBe('0123456'));
  it('validates check digit', () => {
    expect(isValidNationalId('0499370899')).toBe(true);
    expect(isValidNationalId('0499370898')).toBe(false);
    expect(isValidNationalId('1111111111')).toBe(false);
    expect(isValidNationalId('۰۴۹۹۳۷۰۸۹۹')).toBe(true);
  });
  it('pads short ids', () => expect(normalizeNationalId('499370899')).toBe('0499370899'));
});

describe('tehran time', () => {
  it('handles midnight boundary', () => {
    expect(tehranDate(new Date('2026-10-23T20:29:00Z'))).toBe('2026-10-23');
    expect(tehranDate(new Date('2026-10-23T20:31:00Z'))).toBe('2026-10-24');
  });
  it('converts wall time to UTC', () => expect(tehranWallToUtc('2026-10-24', '12:00').toISOString()).toBe('2026-10-24T08:30:00.000Z'));
  it('adds days across months', () => expect(addDays('2026-10-31', 1)).toBe('2026-11-01'));
});

describe('rbac & money', () => {
  it('SuperAdmin has no financeWrite', () => expect(hasPermission('SuperAdmin', 'financeWrite')).toBe(false));
  it('no role manages its own level', () => {
    expect(canManage('StudentAffairs', 'StudentAffairs' as never)).toBe(false);
    expect(canManage('NutritionManager', 'Operator')).toBe(true);
    expect(canManage('StudentAffairs', 'Operator')).toBe(false);
  });
  it('parses rial strictly', () => {
    expect(parseRial('120000')).toBe(120000n);
    expect(() => parseRial('12.5')).toThrow();
  });
});
