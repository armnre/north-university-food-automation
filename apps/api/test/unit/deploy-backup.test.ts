import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const BACKUP_SH = join(REPO_ROOT, 'deploy/backup.sh');
const DRILL_SH = join(REPO_ROOT, 'deploy/restore-drill.sh');
const VALID_RECIPIENT = `age1${'q'.repeat(58)}`;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCliShims(binDir: string, options?: { brokenToc?: boolean; unbalancedLedger?: boolean }) {
  mkdirSync(binDir, { recursive: true });

  const writeBin = (name: string, body: string) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, 'utf8');
    chmodSync(p, 0o755);
  };

  writeBin('pg_dump', `printf 'PGDMP-MOCK-CUSTOM-FORMAT\\nTABLE students\\nTABLE accounts\\nTABLE reservations\\n'`);

  writeBin(
    'pg_restore',
    options?.brokenToc
      ? `if [[ "\${1:-}" == "--list" ]]; then printf '1; 0 0 COMMENT\\n'; exit 0; fi`
      : `if [[ "\${1:-}" == "--list" ]]; then
           for i in 1 2 3 4 5 6; do printf '%s; 1259 %s TABLE public tbl_%s food_migrator\\n' "$i" "$i" "$i"; done
           exit 0
         fi
         exit 0`,
  );

  writeBin(
    'age',
    `OUT=""
     while [[ $# -gt 0 ]]; do
       case "$1" in
         -r|-i) shift 2 ;;
         -d) shift ;;
         -o) OUT="$2"; shift 2 ;;
         *) IN="$1"; shift ;;
       esac
     done
     cat "$IN" > "$OUT"`,
  );

  writeBin(
    'psql',
    `QUERY="\${*: -1}"
     if [[ "$QUERY" == *"format("* ]]; then
       printf 'students=120 accounts=120 offerings=8 reservations=45 ledger_tx=50 ledger_entries=100 payments=12 reminders=10\\n'
     elif [[ "$QUERY" == *"COALESCE(SUM(amount_rial), 0)::bigint"* ]]; then
       printf '${options?.unbalancedLedger ? '5000' : '0'}\\n'
     elif [[ "$QUERY" == *"COUNT(*)"* ]]; then
       printf '0\\n'
     fi`,
  );

  writeBin('logger', `exit 0`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe('اسکریپت‌های پشتیبان‌گیری رمزنگاری‌شده و تمرین بازیابی (deploy/backup.sh & restore-drill.sh)', () => {
  it('backup.sh: تولید فایل‌های .age و .sha256 با مجوز 0600، حذف فایل‌های قدیمی‌تر از ۱۴ روز و هشدار نبود مقصد برون‌سروری', () => {
    const work = makeTempDir('food-backup-test-');
    const binDir = join(work, 'bin');
    const backupDir = join(work, 'backups');
    const uploadsDir = join(work, 'uploads');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'food-1.webp'), 'mock-webp-bytes');
    createCliShims(binDir);

    // ساخت یک فایل قدیمی ۲۰ روزه برای تست سیاست نگهداری ۱۴ روزه
    const staleFile = join(backupDir, 'db-food_automation-20250101-033000.dump.age');
    writeFileSync(staleFile, 'old');
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(staleFile, twentyDaysAgo, twentyDaysAgo);

    const res = spawnSync('bash', [BACKUP_SH], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        UPLOAD_DIR: uploadsDir,
        BACKUP_AGE_RECIPIENT: VALID_RECIPIENT,
        BACKUP_RETENTION_DAYS: '14',
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('بدون نسخه‌ی خارج از سرور، بکاپ ناقص است');
    expect(existsSync(staleFile)).toBe(false);

    const files = readdirSync(backupDir);
    const encDump = files.find((f) => f.endsWith('.dump.age'));
    const encDumpSha = files.find((f) => f.endsWith('.dump.age.sha256'));
    const encUploads = files.find((f) => f.endsWith('.tar.gz.age'));
    const rawDump = files.find((f) => f.endsWith('.dump'));

    expect(encDump).toBeDefined();
    expect(encDumpSha).toBeDefined();
    expect(encUploads).toBeDefined();
    expect(rawDump).toBeUndefined();

    const mode = statSync(join(backupDir, encDump!)).mode & 0o777;
    expect(mode).toBe(0o600);

    // راستی‌آزمایی واقعی sha256sum روی خروجی تولیدشده
    execFileSync('sha256sum', ['--check', '--status', encDumpSha!], { cwd: backupDir });
  });

  it('backup.sh: در صورت نبود کلید عمومی، حضور کلید خصوصی روی سرور یا خرابی pg_restore با کد غیرصفر خارج می‌شود', () => {
    const work = makeTempDir('food-backup-fail-');
    const binDir = join(work, 'bin');
    const backupDir = join(work, 'backups');
    mkdirSync(backupDir, { recursive: true });
    createCliShims(binDir);

    // ۱) نبود BACKUP_AGE_RECIPIENT
    const missingKey = spawnSync('bash', [BACKUP_SH], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        BACKUP_AGE_RECIPIENT: '',
      },
      encoding: 'utf8',
    });
    expect(missingKey.status).not.toBe(0);

    // ۲) حضور تصادفی کلید خصوصی روی سرور
    const accidentalPriv = join(backupDir, 'accidental.key');
    writeFileSync(accidentalPriv, ['AGE', 'SECRET', 'KEY', '1MOCKTESTONLY'].join('-'));
    const privDetected = spawnSync('bash', [BACKUP_SH], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        BACKUP_AGE_RECIPIENT: VALID_RECIPIENT,
      },
      encoding: 'utf8',
    });
    expect(privDetected.status).not.toBe(0);
    expect(privDetected.stderr).toContain('کلید خصوصی age روی سرور شناسایی شد');
    rmSync(accidentalPriv);

    // ۳) خرابی آرشیو دامپ در pg_restore --list
    const brokenBin = join(work, 'bin-broken');
    createCliShims(brokenBin, { brokenToc: true });
    const brokenToc = spawnSync('bash', [BACKUP_SH], {
      env: {
        ...process.env,
        PATH: `${brokenBin}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        BACKUP_AGE_RECIPIENT: VALID_RECIPIENT,
      },
      encoding: 'utf8',
    });
    expect(brokenToc.status).not.toBe(0);
  });

  it('restore-drill.sh: محافظت در برابر نام دیتابیس اصلی، بررسی تراز صفر دفتر کل و موفقیت در حالت سالم', () => {
    const work = makeTempDir('food-drill-test-');
    const binDir = join(work, 'bin');
    const backupDir = join(work, 'backups');
    mkdirSync(backupDir, { recursive: true });
    createCliShims(binDir);

    // ابتدا یک بکاپ معتبر بسازیم
    execFileSync('bash', [BACKUP_SH], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        BACKUP_AGE_RECIPIENT: VALID_RECIPIENT,
      },
    });

    // ۱) جلوگیری از اجرای تمرین روی دیتابیس اصلی یا shomaldoc
    const unsafeDb = spawnSync('bash', [DRILL_SH], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        RESTORE_DRILL_DB: 'food_automation',
      },
      encoding: 'utf8',
    });
    expect(unsafeDb.status).not.toBe(0);

    // ۲) اجرای موفق روی food_restore_test
    const okDrill = spawnSync('bash', [DRILL_SH], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        RESTORE_DRILL_DB: 'food_restore_test',
      },
      encoding: 'utf8',
    });
    expect(okDrill.status).toBe(0);
    expect(okDrill.stdout).toContain('net_sum=0');
    expect(okDrill.stdout).toContain('food_restore_test حذف گردید');

    // ۳) تشخیص عدم تراز دفتر کل در تمرین بازیابی
    const unbalancedBin = join(work, 'bin-unbalanced');
    createCliShims(unbalancedBin, { unbalancedLedger: true });
    const badLedger = spawnSync('bash', [DRILL_SH], {
      env: {
        ...process.env,
        PATH: `${unbalancedBin}:${process.env.PATH ?? ''}`,
        BACKUP_ENV_LOADED: '1',
        BACKUP_PG_DIRECT: 'true',
        BACKUP_DIR: backupDir,
        RESTORE_DRILL_DB: 'food_restore_test',
      },
      encoding: 'utf8',
    });
    expect(badLedger.status).not.toBe(0);
    expect(badLedger.stderr).toContain('عدم تراز دفتر کل');
  });
});
