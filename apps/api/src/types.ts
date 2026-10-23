import type { Logger } from 'pino';
import type { EmployeeStatus, Permission, StaffRole, StaffStatus, StudentStatus, SubjectType } from '@food/shared';
import type { AppEnv } from './config/env.js';
import type { Db, Tx } from './db/client.js';

/** وابستگی‌های مشترک سرویس‌ها. */
export type ServiceDeps = {
  db: Db;
  env: AppEnv;
  log: Logger;
};

export type Actor =
  | { type: 'Staff'; id: string; label: string }
  | { type: 'Student'; id: string; label: string }
  | { type: 'Employee'; id: string; label: string }
  | { type: 'System'; id: string; label: string }
  | { type: 'Anonymous'; id: string; label: string }
  | { type: 'Gateway'; id: string; label: string };

/** سوژهٔ احراز‌هویت‌شده در هر درخواست. */
export type AuthContext =
  | {
      kind: 'student';
      subjectType: Extract<SubjectType, 'Student'>;
      sessionId: string;
      studentId: string;
      accountId: string;
      studentNumber: string;
      fullName: string;
      faculty: string;
      major: string;
      degree: string;
      entryYear: number | null;
      nationalIdLast4: string;
      status: StudentStatus;
      customerGroup: 'Student';
      balanceRial: number;
    }
  | {
      kind: 'employee';
      subjectType: Extract<SubjectType, 'Employee'>;
      sessionId: string;
      employeeId: string;
      accountId: string;
      username: string;
      fullName: string;
      department: string;
      customerGroup: 'Employee' | 'Faculty' | 'Contractor';
      status: EmployeeStatus;
      mustChangePassword: boolean;
      balanceRial: number;
    }
  | {
      kind: 'staff';
      subjectType: Extract<SubjectType, 'Staff'>;
      sessionId: string;
      staffId: string;
      username: string;
      fullName: string;
      role: StaffRole;
      permissions: readonly Permission[];
      status: StaffStatus;
      contractorId: string | null;
      cafeteriaId: string | null;
      mustChangePassword: boolean;
    };

/** سوژهٔ مشتری سلف (دانشجو یا کارمند) — هر دو کیف پول و منو دارند. */
export type CustomerAuth = Extract<AuthContext, { kind: 'student' } | { kind: 'employee' }>;

/** برچسب انسان‌خوان برای ممیزی. */
export function actorOf(auth: AuthContext): Actor {
  switch (auth.kind) {
    case 'student':
      return { type: 'Student', id: auth.studentId, label: auth.studentNumber };
    case 'employee':
      return { type: 'Employee', id: auth.employeeId, label: auth.username };
    default:
      return { type: 'Staff', id: auth.staffId, label: auth.fullName || auth.username };
  }
}

export type { Db, Tx };
