#!/usr/bin/env bash
# ============================================================================
# deploy/backup.sh — پشتیبان‌گیری روزانه از دیتابیس PostgreSQL و تصاویر غذا
# خروجی در /var/backups/food با مجوز 0600 ذخیره و سلامت فایل با pg_restore بررسی می‌شود.
# ============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/food}"
DB_NAME="${FOOD_DB_NAME:-food_automation}"
UPLOADS_DIR="${UPLOAD_DIR:-/opt/food/shared/uploads}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "${BACKUP_DIR}"
chmod 0700 "${BACKUP_DIR}"

umask 0077
DB_DUMP="${BACKUP_DIR}/db-${DB_NAME}-${STAMP}.dump"
UPLOADS_TAR="${BACKUP_DIR}/uploads-${STAMP}.tar.gz"

sudo -u postgres pg_dump -Fc "${DB_NAME}" > "${DB_DUMP}"
chmod 0600 "${DB_DUMP}"

# راستی‌آزمایی خوانایی آرشیو دامپ
pg_restore --list "${DB_DUMP}" >/dev/null

if [[ -d "${UPLOADS_DIR}" ]]; then
  tar -czf "${UPLOADS_TAR}" -C "${UPLOADS_DIR}" .
  chmod 0600 "${UPLOADS_TAR}"
fi

# حذف پشتیبان‌های قدیمی‌تر از دورهٔ نگه‌داری (پیش‌فرض ۱۴ روز)
find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +"${RETENTION_DAYS}" -delete

# ارسال اختیاری به سرور پشتیبان خارجی (در صورت تنظیم BACKUP_RSYNC_TARGET در محیط)
if [[ -n "${BACKUP_RSYNC_TARGET:-}" ]]; then
  rsync -az --chmod=F600 "${DB_DUMP}" "${UPLOADS_TAR}" "${BACKUP_RSYNC_TARGET}"
fi

logger -t food-backup "پشتیبان‌گیری با موفقیت انجام شد: ${DB_DUMP}"
