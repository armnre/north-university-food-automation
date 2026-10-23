#!/usr/bin/env bash
# ============================================================================
# deploy/backup.sh — پشتیبان‌گیری روزانهٔ رمزنگاری‌شده از PostgreSQL و تصاویر غذا
#
# ویژگی‌ها:
#  ۱) دامپ با فرمت سفارشی PostgreSQL (pg_dump -Fc) و راستی‌آزمایی سلامت با pg_restore --list
#  ۲) رمزنگاری نامتقارن با کلید عمومی age (BACKUP_AGE_RECIPIENT) — کلید خصوصی هرگز روی سرور نیست
#  ۳) تولید و راستی‌آزمایی فوری چک‌سام SHA-256 (.sha256) برای هر فایل رمزنگاری‌شده
#  ۴) نگه‌داری خودکار ۱۴ روزه (حذف نسخه‌های قدیمی‌تر)
#  ۵) انتقال خارج از سرور با rsync یا scp (و ثبت هشدار صریح در صورت عدم تنظیم)
#  ۶) ثبت خطا در journald و خروج با کد غیرصفر در هرگونه شکست
# ============================================================================
set -Eeuo pipefail

APP_ENV_FILE="${FOOD_ENV_FILE:-/etc/food/app.env}"
if [[ -z "${BACKUP_ENV_LOADED:-}" && -r "${APP_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${APP_ENV_FILE}"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-/var/backups/food}"
DB_NAME="${FOOD_DB_NAME:-food_automation}"
UPLOADS_DIR="${UPLOAD_DIR:-/opt/food/shared/uploads}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
AGE_RECIPIENT_FILE="${BACKUP_AGE_RECIPIENT_FILE:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK_DIR=""

log_info() {
  local msg="$1"
  if command -v logger >/dev/null 2>&1; then
    logger -p user.info -t food-backup -- "${msg}" || true
  fi
  printf '[food-backup] INFO: %s\n' "${msg}"
}

log_warn() {
  local msg="$1"
  if command -v logger >/dev/null 2>&1; then
    logger -p user.warning -t food-backup -- "${msg}" || true
  fi
  printf '[food-backup] WARN: %s\n' "${msg}" >&2
}

log_err() {
  local msg="$1"
  if command -v logger >/dev/null 2>&1; then
    logger -p user.err -t food-backup -- "${msg}" || true
  fi
  printf '[food-backup] ERROR: %s\n' "${msg}" >&2
}

cleanup() {
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}

on_error() {
  local exit_code="$?"
  local line_no="${1:-unknown}"
  log_err "پشتیبان‌گیری در خط ${line_no} با کد خروج ${exit_code} شکست خورد."
  cleanup
  exit "${exit_code}"
}

trap 'on_error ${LINENO}' ERR
trap cleanup EXIT

umask 0077
mkdir -p "${BACKUP_DIR}"
chmod 0700 "${BACKUP_DIR}"

if ! command -v age >/dev/null 2>&1; then
  log_err "ابزار رمزنگاری age نصب نیست (sudo apt-get install -y age)."
  exit 1
fi

for cmd in pg_dump pg_restore sha256sum; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    log_err "ابزار پیش‌نیاز '${cmd}' در PATH یافت نشد."
    exit 1
  fi
done

if [[ -z "${AGE_RECIPIENT}" && -n "${AGE_RECIPIENT_FILE}" && -r "${AGE_RECIPIENT_FILE}" ]]; then
  AGE_RECIPIENT="$(grep -vE '^\s*(#|$)' "${AGE_RECIPIENT_FILE}" | head -n1 | tr -d '[:space:]')"
fi

if [[ -z "${AGE_RECIPIENT}" ]]; then
  log_err "متغیر BACKUP_AGE_RECIPIENT (کلید عمومی age1...) تنظیم نشده است؛ ذخیرهٔ بکاپ بدون رمزنگاری مجاز نیست."
  exit 1
fi

if [[ ! "${AGE_RECIPIENT}" =~ ^age1[0-9a-z]{58}$ ]]; then
  log_err "فرمت کلید عمومی BACKUP_AGE_RECIPIENT نامعتبر است (باید با age1 شروع شود)."
  exit 1
fi

# اطمینان از عدم حضور کلید خصوصی age روی سرور تولیدی
PRIVATE_KEY_PREFIX="AGE-SECRET-KEY-"
if { [[ -d /etc/food ]] && grep -rqF "${PRIVATE_KEY_PREFIX}" /etc/food 2>/dev/null; } ||
   grep -rqF "${PRIVATE_KEY_PREFIX}" "${BACKUP_DIR}" 2>/dev/null; then
  log_err "خطای امنیتی بحرانی: کلید خصوصی age روی سرور شناسایی شد! کلید خصوصی باید فقط در گاوصندوق خارج از سرور نگهداری شود."
  exit 1
fi

WORK_DIR="$(mktemp -d "${BACKUP_DIR}/.tmp-backup-${STAMP}-XXXXXX")"
chmod 0700 "${WORK_DIR}"

RAW_DUMP="${WORK_DIR}/db-${DB_NAME}-${STAMP}.dump"
ENC_DUMP="${BACKUP_DIR}/db-${DB_NAME}-${STAMP}.dump.age"
RAW_UPLOADS="${WORK_DIR}/uploads-${STAMP}.tar.gz"
ENC_UPLOADS="${BACKUP_DIR}/uploads-${STAMP}.tar.gz.age"

# ۱) تهیهٔ دامپ دیتابیس
if [[ "${BACKUP_PG_DIRECT:-false}" == "true" ]]; then
  pg_dump -Fc "${DB_NAME}" > "${RAW_DUMP}"
else
  sudo -u postgres pg_dump -Fc "${DB_NAME}" > "${RAW_DUMP}"
fi

# ۲) راستی‌آزمایی سلامت آرشیو دامپ پیش از رمزنگاری
TOC_LINES="$(pg_restore --list "${RAW_DUMP}" | grep -cE '^[0-9]+;' || true)"
if [[ "${TOC_LINES}" -lt 5 ]]; then
  log_err "خروجی pg_restore --list ناقص یا خالی است (${TOC_LINES} مدخل)."
  exit 1
fi

# ۳) رمزنگاری با کلید عمومی age و حذف فوری دامپ خام
age -r "${AGE_RECIPIENT}" -o "${ENC_DUMP}" "${RAW_DUMP}"
chmod 0600 "${ENC_DUMP}"
rm -f "${RAW_DUMP}"

(
  cd "${BACKUP_DIR}"
  sha256sum "$(basename "${ENC_DUMP}")" > "$(basename "${ENC_DUMP}").sha256"
  chmod 0600 "$(basename "${ENC_DUMP}").sha256"
  sha256sum --check --status "$(basename "${ENC_DUMP}").sha256"
)

ARTIFACTS=("${ENC_DUMP}" "${ENC_DUMP}.sha256")

# ۴) آرشیو و رمزنگاری تصاویر غذا (در صورت وجود پوشه)
if [[ -d "${UPLOADS_DIR}" ]]; then
  tar -czf "${RAW_UPLOADS}" -C "${UPLOADS_DIR}" .
  age -r "${AGE_RECIPIENT}" -o "${ENC_UPLOADS}" "${RAW_UPLOADS}"
  chmod 0600 "${ENC_UPLOADS}"
  rm -f "${RAW_UPLOADS}"

  (
    cd "${BACKUP_DIR}"
    sha256sum "$(basename "${ENC_UPLOADS}")" > "$(basename "${ENC_UPLOADS}").sha256"
    chmod 0600 "$(basename "${ENC_UPLOADS}").sha256"
    sha256sum --check --status "$(basename "${ENC_UPLOADS}").sha256"
  )
  ARTIFACTS+=("${ENC_UPLOADS}" "${ENC_UPLOADS}.sha256")
fi

# ۵) حذف پشتیبان‌های قدیمی‌تر از دورهٔ نگه‌داری (پیش‌فرض ۱۴ روز)
find "${BACKUP_DIR}" -maxdepth 1 -type f \
  \( -name 'db-*.dump*' -o -name 'uploads-*.tar.gz*' \) \
  -mtime +"${RETENTION_DAYS}" -delete

# ۶) ارسال به مقصد خارج از سرور (در صورت تنظیم) یا ثبت هشدار صریح
if [[ -n "${BACKUP_RSYNC_TARGET:-}" ]]; then
  rsync -az --chmod=F600 "${ARTIFACTS[@]}" "${BACKUP_RSYNC_TARGET}"
  log_info "انتقال خارج از سرور با rsync با موفقیت انجام شد."
elif [[ -n "${BACKUP_SCP_TARGET:-}" ]]; then
  scp -B -q "${ARTIFACTS[@]}" "${BACKUP_SCP_TARGET}"
  log_info "انتقال خارج از سرور با scp با موفقیت انجام شد."
else
  log_warn "مقصد خارج از سرور (BACKUP_RSYNC_TARGET یا BACKUP_SCP_TARGET) تنظیم نشده است؛ بدون نسخه‌ی خارج از سرور، بکاپ ناقص است."
fi

DUMP_SHA="$(awk '{print $1}' "${ENC_DUMP}.sha256")"
log_info "پشتیبان‌گیری رمزنگاری‌شده با موفقیت کامل شد: file=$(basename "${ENC_DUMP}") sha256=${DUMP_SHA}"
