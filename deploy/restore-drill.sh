#!/usr/bin/env bash
# ============================================================================
# deploy/restore-drill.sh — تمرین خودکار و غیرمخرب بازیابی به دیتابیس موقت
#
# عملکرد:
#  ۱) بازیابی بکاپ در دیتابیس موقت ایزوله (food_restore_test) — بدون کوچک‌ترین تماس با food_automation یا shomaldoc
#     - حالت الف (--encrypted FILE): بررسی .sha256 و رمزگشایی با BACKUP_AGE_IDENTITY_FILE (مخصوص محیط تمرین/آفلاین)
#     - حالت ب (--dump FILE): بازیابی مستقیم از فایل دامپ بازگشایی‌شده
#     - حالت ج (پیش‌فرض ماهانه روی سرور تولیدی که کلید خصوصی ندارد): راستی‌آزمایی چک‌سام .sha256 آخرین بکاپ
#       رمزنگاری‌شده در /var/backups/food + تهیهٔ دامپ موقت زنده و آزمون کامل pg_restore در food_restore_test
#  ۲) بررسی شمارش جدول‌ها، تراز صفر دفتر کل دوطرفه، برابری موجودی حساب‌ها با جمع آرتیکل‌ها و سلامت FKها
#  ۳) حذف قطعی دیتابیس موقت (حتی در صورت خطا) و ثبت نتیجه در journald
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
SOURCE_DB="${FOOD_DB_NAME:-food_automation}"
DRILL_DB="${RESTORE_DRILL_DB:-food_restore_test}"
DB_ROLE="${FOOD_MIGRATOR_ROLE:-food_migrator}"
MODE="auto"
INPUT_FILE=""
WORK_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump)
      MODE="dump"
      INPUT_FILE="${2:-}"
      shift 2
      ;;
    --encrypted)
      MODE="encrypted"
      INPUT_FILE="${2:-}"
      shift 2
      ;;
    *)
      printf 'گزینهٔ ناشناخته: %s\nاستفاده: %s [--dump FILE.dump | --encrypted FILE.dump.age]\n' "$1" "$0" >&2
      exit 2
      ;;
  esac
done

log_info() {
  local msg="$1"
  if command -v logger >/dev/null 2>&1; then
    logger -p user.info -t food-restore-drill -- "${msg}" || true
  fi
  printf '[restore-drill] INFO: %s\n' "${msg}"
}

log_err() {
  local msg="$1"
  if command -v logger >/dev/null 2>&1; then
    logger -p user.err -t food-restore-drill -- "${msg}" || true
  fi
  printf '[restore-drill] ERROR: %s\n' "${msg}" >&2
}

run_psql() {
  if [[ "${BACKUP_PG_DIRECT:-false}" == "true" ]]; then
    psql -v ON_ERROR_STOP=1 "$@"
  else
    sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"
  fi
}

# محافظت ایمنی مطلق: هرگز اجازه نده DRILL_DB برابر دیتابیس اصلی یا سیستمی باشد
if [[ -z "${DRILL_DB}" || "${DRILL_DB}" == "${SOURCE_DB}" || "${DRILL_DB}" == "postgres" || "${DRILL_DB}" == *"shomal"* ]]; then
  log_err "نام دیتابیس آزمایشی (${DRILL_DB}) غیرمجاز است! فقط نام موقت مانند food_restore_test مجاز است."
  exit 1
fi

if [[ ! "${DRILL_DB}" =~ ^[a-z0-9_]+$ ]]; then
  log_err "نام دیتابیس آزمایشی فقط می‌تواند شامل حروف کوچک انگلیسی، عدد و خط زیرین باشد."
  exit 1
fi

drop_temp_db() {
  run_psql -d postgres -Atqc "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '${DRILL_DB}' AND pid <> pg_backend_pid();
  " >/dev/null 2>&1 || true
  run_psql -d postgres -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\";" >/dev/null 2>&1 || true
}

cleanup() {
  drop_temp_db
  if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}

on_error() {
  local exit_code="$?"
  local line_no="${1:-unknown}"
  log_err "تمرین بازیابی در خط ${line_no} با کد خروج ${exit_code} ناموفق بود."
  cleanup
  exit "${exit_code}"
}

trap 'on_error ${LINENO}' ERR
trap cleanup EXIT

for cmd in psql pg_dump pg_restore sha256sum; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    log_err "ابزار '${cmd}' در PATH یافت نشد."
    exit 1
  fi
done

umask 0077
WORK_DIR="$(mktemp -d "/tmp/food-restore-drill-XXXXXX")"
chmod 0700 "${WORK_DIR}"
DUMP_TO_RESTORE=""

if [[ "${MODE}" == "encrypted" ]]; then
  if [[ -z "${INPUT_FILE}" || ! -r "${INPUT_FILE}" ]]; then
    log_err "فایل رمزنگاری‌شده یافت نشد: ${INPUT_FILE}"
    exit 1
  fi
  if [[ -z "${BACKUP_AGE_IDENTITY_FILE:-}" || ! -r "${BACKUP_AGE_IDENTITY_FILE}" ]]; then
    log_err "برای رمزگشایی فایل .age در محیط تمرین، متغیر BACKUP_AGE_IDENTITY_FILE باید به فایل کلید خصوصی اشاره کند."
    exit 1
  fi
  if [[ -r "${INPUT_FILE}.sha256" ]]; then
    (cd "$(dirname "${INPUT_FILE}")" && sha256sum --check --status "$(basename "${INPUT_FILE}").sha256")
    log_info "چک‌سام SHA-256 فایل بکاپ رمزنگاری‌شده تأیید شد."
  fi
  DUMP_TO_RESTORE="${WORK_DIR}/decrypted.dump"
  age -d -i "${BACKUP_AGE_IDENTITY_FILE}" -o "${DUMP_TO_RESTORE}" "${INPUT_FILE}"
elif [[ "${MODE}" == "dump" ]]; then
  if [[ -z "${INPUT_FILE}" || ! -r "${INPUT_FILE}" ]]; then
    log_err "فایل دامپ یافت نشد: ${INPUT_FILE}"
    exit 1
  fi
  DUMP_TO_RESTORE="${INPUT_FILE}"
else
  # حالت خودکار ماهانه روی سرور تولیدی (بدون نیاز به کلید خصوصی روی سرور):
  # ۱) بررسی یکپارچگی SHA-256 جدیدترین فایل رمزنگاری‌شدهٔ روزانه
  LATEST_ENC="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "db-${SOURCE_DB}-*.dump.age" -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)"
  if [[ -z "${LATEST_ENC}" ]]; then
    log_err "هیچ فایل بکاپ رمزنگاری‌شده‌ای در ${BACKUP_DIR} یافت نشد!"
    exit 1
  fi
  if [[ ! -r "${LATEST_ENC}.sha256" ]]; then
    log_err "فایل چک‌سام ${LATEST_ENC}.sha256 یافت نشد!"
    exit 1
  fi
  (cd "${BACKUP_DIR}" && sha256sum --check --status "$(basename "${LATEST_ENC}").sha256")
  log_info "سلامت چک‌سام آخرین بکاپ رمزنگاری‌شده تأیید شد: $(basename "${LATEST_ENC}")"

  # ۲) تهیهٔ دامپ موقت از دیتابیس جاری برای راستی‌آزمایی زنجیرهٔ pg_dump -> pg_restore -> یکپارچگی داده
  DUMP_TO_RESTORE="${WORK_DIR}/live-drill.dump"
  if [[ "${BACKUP_PG_DIRECT:-false}" == "true" ]]; then
    pg_dump -Fc "${SOURCE_DB}" > "${DUMP_TO_RESTORE}"
  else
    sudo -u postgres pg_dump -Fc "${SOURCE_DB}" > "${DUMP_TO_RESTORE}"
  fi
fi

pg_restore --list "${DUMP_TO_RESTORE}" >/dev/null

# ایجاد دیتابیس موقت و بازیابی کامل
drop_temp_db
run_psql -d postgres -c "CREATE DATABASE \"${DRILL_DB}\" ENCODING 'UTF8' TEMPLATE template0;"

if [[ "${BACKUP_PG_DIRECT:-false}" == "true" ]]; then
  pg_restore --no-owner --no-privileges --exit-on-error -d "${DRILL_DB}" "${DUMP_TO_RESTORE}"
else
  ROLE_EXISTS="$(run_psql -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_ROLE}'" || true)"
  if [[ "${ROLE_EXISTS}" == "1" ]]; then
    sudo -u postgres pg_restore --no-owner --role="${DB_ROLE}" --exit-on-error -d "${DRILL_DB}" "${DUMP_TO_RESTORE}"
  else
    sudo -u postgres pg_restore --no-owner --no-privileges --exit-on-error -d "${DRILL_DB}" "${DUMP_TO_RESTORE}"
  fi
fi

# ۱) بررسی وجود و شمارش جدول‌های کلیدی
TABLE_SUMMARY="$(run_psql -d "${DRILL_DB}" -Atqc "
  SELECT format(
    'students=%s accounts=%s offerings=%s reservations=%s ledger_tx=%s ledger_entries=%s payments=%s reminders=%s',
    (SELECT COUNT(*) FROM public.students),
    (SELECT COUNT(*) FROM public.accounts),
    (SELECT COUNT(*) FROM public.meal_offerings),
    (SELECT COUNT(*) FROM public.reservations),
    (SELECT COUNT(*) FROM public.ledger_transactions),
    (SELECT COUNT(*) FROM public.ledger_entries),
    (SELECT COUNT(*) FROM public.payments),
    (SELECT COUNT(*) FROM public.reservation_reminders)
  );
")"

# ۲) بررسی تراز صفر دفتر کل دوطرفه
NET_SUM="$(run_psql -d "${DRILL_DB}" -Atqc "SELECT COALESCE(SUM(amount_rial), 0)::bigint FROM public.ledger_entries;")"
UNBALANCED_TX="$(run_psql -d "${DRILL_DB}" -Atqc "
  SELECT COUNT(*)::int FROM (
    SELECT transaction_id FROM public.ledger_entries GROUP BY transaction_id HAVING SUM(amount_rial) <> 0
  ) u;
")"
if [[ "${NET_SUM}" != "0" || "${UNBALANCED_TX}" != "0" ]]; then
  log_err "عدم تراز دفتر کل در دیتابیس بازیابی‌شده! net_sum=${NET_SUM} unbalanced_tx=${UNBALANCED_TX}"
  exit 1
fi

# ۳) برابری موجودی کش‌شدهٔ هر حساب با مجموع آرتیکل‌های دفتر کل + عدم وجود موجودی منفی
MISMATCHED_ACCOUNTS="$(run_psql -d "${DRILL_DB}" -Atqc "
  SELECT COUNT(*)::int
  FROM public.accounts a
  LEFT JOIN (
    SELECT account_id, COALESCE(SUM(amount_rial), 0)::bigint AS s
    FROM public.ledger_entries
    WHERE account_id IS NOT NULL
    GROUP BY account_id
  ) le ON le.account_id = a.id
  WHERE a.balance_rial <> COALESCE(le.s, 0);
")"
NEGATIVE_ACCOUNTS="$(run_psql -d "${DRILL_DB}" -Atqc "SELECT COUNT(*)::int FROM public.accounts WHERE balance_rial < 0;")"
if [[ "${MISMATCHED_ACCOUNTS}" != "0" || "${NEGATIVE_ACCOUNTS}" != "0" ]]; then
  log_err "مغایرت موجودی حساب‌ها در دیتابیس بازیابی‌شده! mismatch=${MISMATCHED_ACCOUNTS} negative=${NEGATIVE_ACCOUNTS}"
  exit 1
fi

# ۴) سلامت قیدهای کلید خارجی (FK) و عدم وجود ردیف‌های یتیم
INVALID_FKS="$(run_psql -d "${DRILL_DB}" -Atqc "SELECT COUNT(*)::int FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;")"
ORPHAN_ROWS="$(run_psql -d "${DRILL_DB}" -Atqc "
  SELECT (
    (SELECT COUNT(*) FROM public.reservations r LEFT JOIN public.accounts a ON a.id = r.account_id WHERE a.id IS NULL) +
    (SELECT COUNT(*) FROM public.reservations r LEFT JOIN public.meal_offerings o ON o.id = r.offering_id WHERE o.id IS NULL) +
    (SELECT COUNT(*) FROM public.ledger_entries le LEFT JOIN public.ledger_transactions lt ON lt.id = le.transaction_id WHERE lt.id IS NULL) +
    (SELECT COUNT(*) FROM public.deliveries d LEFT JOIN public.reservations r ON r.id = d.reservation_id WHERE r.id IS NULL)
  )::int;
")"
if [[ "${INVALID_FKS}" != "0" || "${ORPHAN_ROWS}" != "0" ]]; then
  log_err "خطای کلید خارجی در دیتابیس بازیابی‌شده! invalid_fks=${INVALID_FKS} orphans=${ORPHAN_ROWS}"
  exit 1
fi

# پاک‌سازی دیتابیس موقت در پایان تمرین موفق
drop_temp_db
log_info "تمرین بازیابی با موفقیت ۱۰۰٪ انجام شد و دیتابیس موقت ${DRILL_DB} حذف گردید (${TABLE_SUMMARY}، net_sum=0، mismatch=0، invalid_fks=0)."
