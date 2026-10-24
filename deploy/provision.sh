#!/usr/bin/env bash
# ============================================================================
# deploy/provision.sh — آماده‌سازی اولیه و ایمن سرور تولیدی (Ubuntu 24.04 + Plesk)
#
# اصول ایمنی:
#  - هرگز Node سیستمی (v18) یا سرویس‌های دیگر (مانند shomaldoc روی پورت 3080) را لمس نمی‌کند.
#  - Node 22 LTS را به صورت کاملاً ایزوله در /opt/food/node/current نصب می‌کند (از آرشیو محلی یا دانلود).
#  - در PostgreSQL فقط دیتابیس food_automation و نقش‌های food_migrator و food_app را (در صورت نبود) می‌سازد.
#  - فایل تنظیمات حساس را در /etc/food/app.env با مالکیت root:food و مجوز 0640 ایجاد می‌کند.
# ============================================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "این اسکریپت باید با دسترسی root (sudo) اجرا شود." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOOD_ROOT="/opt/food"
ENV_DIR="/etc/food"
ENV_FILE="${ENV_DIR}/app.env"
BACKUP_DIR="/var/backups/food"
DB_NAME="${FOOD_DB_NAME:-food_automation}"
PUBLIC_URL="${PUBLIC_BASE_URL:-https://dining.example.edu}"
API_PORT="${PORT:-3101}"
NODE_TARBALL="${NODE_TARBALL:-}"

echo "=== ۰. نصب بسته‌های پایهٔ سیستمی (age، rsync، xz-utils، curl، gnupg) بدون تغییر Node سیستمی ==="
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends age ca-certificates curl gnupg rsync xz-utils
fi

echo "=== ۱. ایجاد کاربر و گروه سیستمی بدون شل ورود (food) ==="
if ! getent group food >/dev/null; then
  groupadd --system food
fi
if ! id -u food >/dev/null 2>&1; then
  useradd --system --gid food --home-dir "${FOOD_ROOT}" --no-create-home --shell /usr/sbin/nologin food
fi

echo "=== ۲. ساخت ساختار دایرکتوری‌ها (/opt/food، /etc/food، /var/backups/food) ==="
mkdir -p "${FOOD_ROOT}/releases" "${FOOD_ROOT}/shared/uploads" "${FOOD_ROOT}/node"
chown -R root:root "${FOOD_ROOT}"
chown -R food:food "${FOOD_ROOT}/shared"
chmod 0750 "${FOOD_ROOT}/shared" "${FOOD_ROOT}/shared/uploads"

mkdir -p "${ENV_DIR}"
chown root:food "${ENV_DIR}"
chmod 0750 "${ENV_DIR}"

mkdir -p "${BACKUP_DIR}"
chown root:root "${BACKUP_DIR}"
chmod 0700 "${BACKUP_DIR}"

echo "=== ۳. نصب ایزولهٔ Node.js 22 LTS با راستی‌آزمایی SHA-256 (بدون curl | bash) ==="
verify_node_sha256() {
  local archive_path="$1"
  local archive_name
  archive_name="$(basename "${archive_path}")"
  local expected_sha="${NODE_EXPECTED_SHA256:-}"

  if [[ -z "${expected_sha}" && -r "${archive_path}.sha256" ]]; then
    expected_sha="$(awk '{print $1}' "${archive_path}.sha256" | head -n1)"
  fi
  if [[ -z "${expected_sha}" && -n "${NODE_SHASUMS_FILE:-}" && -r "${NODE_SHASUMS_FILE}" ]]; then
    expected_sha="$(awk -v f="${archive_name}" '$2 == f || $2 == "*"f {print $1}' "${NODE_SHASUMS_FILE}" | head -n1)"
  fi
  if [[ -z "${expected_sha}" ]]; then
    echo "خطا: چک‌سام SHA-256 برای ${archive_name} یافت نشد! فایل ${archive_path}.sha256 یا متغیر NODE_EXPECTED_SHA256 را تامین کنید." >&2
    exit 1
  fi

  local actual_sha
  actual_sha="$(sha256sum "${archive_path}" | awk '{print $1}')"
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    echo "خطای امنیتی: عدم تطابق SHA-256 آرشیو Node.js! expected=${expected_sha} actual=${actual_sha}" >&2
    exit 1
  fi
  echo "  [OK] صحت چک‌سام SHA-256 آرشیو Node.js تأیید شد (${actual_sha})."
}

if [[ "${INSTALL_NODESOURCE_APT:-false}" == "true" ]]; then
  # حالت اختیاری مخصوص سرورهای اختصاصی فاقد Plesk: مخزن رسمی امضاشدهٔ NodeSource با کلید GPG (هرگز بدون curl | bash)
  install -m 0755 -d /etc/apt/keyrings
  TMP_GPG="$(mktemp /tmp/nodesource.gpg.XXXXXX)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o "${TMP_GPG}"
  install -m 0644 "${TMP_GPG}" /etc/apt/keyrings/nodesource.gpg
  rm -f "${TMP_GPG}"
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y --no-install-recommends nodejs
  mkdir -p "${FOOD_ROOT}/node/system-node22/bin"
  ln -sfn /usr/bin/node "${FOOD_ROOT}/node/system-node22/bin/node"
  ln -sfn /usr/bin/npm "${FOOD_ROOT}/node/system-node22/bin/npm"
  ln -sfn "${FOOD_ROOT}/node/system-node22" "${FOOD_ROOT}/node/current"
elif [[ -x "${FOOD_ROOT}/node/current/bin/node" ]] && "${FOOD_ROOT}/node/current/bin/node" -v | grep -qE '^v2[2-9]\.'; then
  echo "Node.js 22+ قبلاً نصب شده است: $("${FOOD_ROOT}/node/current/bin/node" -v)"
else
  if [[ -n "${NODE_TARBALL}" && -f "${NODE_TARBALL}" ]]; then
    echo "نصب Node.js 22 از فایل آرشیو محلی: ${NODE_TARBALL}"
    verify_node_sha256 "${NODE_TARBALL}"
    TMP_NODE_DIR="$(mktemp -d "${FOOD_ROOT}/node/extract.XXXXXX")"
    tar -xf "${NODE_TARBALL}" -C "${TMP_NODE_DIR}" --strip-components=1
    NODE_VER="$("${TMP_NODE_DIR}/bin/node" -v)"
    DEST_NODE_DIR="${FOOD_ROOT}/node/node-${NODE_VER}-linux-x64"
    rm -rf "${DEST_NODE_DIR}"
    mv "${TMP_NODE_DIR}" "${DEST_NODE_DIR}"
    ln -sfn "${DEST_NODE_DIR}" "${FOOD_ROOT}/node/current"
  else
    NODE_VERSION="${NODE_VERSION:-v22.22.3}"
    ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.xz"
    BASE_DIST_URL="${NODE_MIRROR_BASE_URL:-https://nodejs.org/dist/${NODE_VERSION}}"
    echo "دانلود رسمی Node.js ${NODE_VERSION} و فایل SHASUMS256.txt از ${BASE_DIST_URL} ..."
    echo "نکته: اگر سرور دسترسی مستقیم به nodejs.org ندارد، فایل‌های ${ARCHIVE} و SHASUMS256.txt را منتقل کرده و با NODE_TARBALL و NODE_SHASUMS_FILE اجرا کنید."
    TMP_ARCHIVE="$(mktemp "/tmp/${ARCHIVE}.XXXXXX")"
    TMP_SHASUMS="$(mktemp "/tmp/SHASUMS256.txt.XXXXXX")"
    curl -fsSL --connect-timeout 15 --max-time 300 "${BASE_DIST_URL}/${ARCHIVE}" -o "${TMP_ARCHIVE}"
    curl -fsSL --connect-timeout 15 --max-time 60 "${BASE_DIST_URL}/SHASUMS256.txt" -o "${TMP_SHASUMS}"

    EXPECTED_FROM_LIST="$(awk -v f="${ARCHIVE}" '$2 == f || $2 == "*"f {print $1}' "${TMP_SHASUMS}" | head -n1)"
    if [[ -z "${EXPECTED_FROM_LIST}" ]]; then
      rm -f "${TMP_ARCHIVE}" "${TMP_SHASUMS}"
      echo "خطا: مدخل ${ARCHIVE} در SHASUMS256.txt یافت نشد!" >&2
      exit 1
    fi
    if [[ -n "${NODE_EXPECTED_SHA256:-}" && "${NODE_EXPECTED_SHA256}" != "${EXPECTED_FROM_LIST}" ]]; then
      rm -f "${TMP_ARCHIVE}" "${TMP_SHASUMS}"
      echo "خطای امنیتی: مغایرت NODE_EXPECTED_SHA256 با SHASUMS256.txt!" >&2
      exit 1
    fi
    NODE_EXPECTED_SHA256="${EXPECTED_FROM_LIST}" verify_node_sha256 "${TMP_ARCHIVE}"

    DEST_NODE_DIR="${FOOD_ROOT}/node/node-${NODE_VERSION}-linux-x64"
    rm -rf "${DEST_NODE_DIR}"
    mkdir -p "${DEST_NODE_DIR}"
    tar -xJf "${TMP_ARCHIVE}" -C "${DEST_NODE_DIR}" --strip-components=1
    rm -f "${TMP_ARCHIVE}" "${TMP_SHASUMS}"
    ln -sfn "${DEST_NODE_DIR}" "${FOOD_ROOT}/node/current"
  fi
fi

# بررسی قطعی نسخهٔ Node پس از نصب (رد فوری نسخه‌های قدیمی مانند Node 18)
INSTALLED_NODE_VER="$("${FOOD_ROOT}/node/current/bin/node" -v 2>/dev/null || echo none)"
if [[ ! "${INSTALLED_NODE_VER}" =~ ^v2[2-9]\. ]]; then
  echo "خطا: نسخهٔ Node نصب‌شده در ${FOOD_ROOT}/node/current باید >=22 باشد، اما '${INSTALLED_NODE_VER}' گزارش شد!" >&2
  exit 1
fi
echo "  [OK] نسخهٔ نهایی Node.js تأیید شد: ${INSTALLED_NODE_VER}"

echo "=== ۴. ساخت ایمن نقش‌ها و دیتابیس PostgreSQL (بدون دست زدن به سایر دیتابیس‌ها) ==="
MIGRATOR_PASS="$(openssl rand -hex 24)"
APP_PASS="$(openssl rand -hex 24)"

ROLE_MIG_EXISTS="$(sudo -u postgres psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname = 'food_migrator'")"
if [[ "${ROLE_MIG_EXISTS}" != "1" ]]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE food_migrator LOGIN PASSWORD '${MIGRATOR_PASS}';"
  echo "نقش food_migrator ایجاد شد."
else
  echo "نقش food_migrator از قبل وجود دارد (رمز قبلی حفظ شد)."
  MIGRATOR_PASS="KEEP_EXISTING_OR_UPDATE_MANUALLY"
fi

ROLE_APP_EXISTS="$(sudo -u postgres psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname = 'food_app'")"
if [[ "${ROLE_APP_EXISTS}" != "1" ]]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE food_app LOGIN PASSWORD '${APP_PASS}';"
  echo "نقش food_app ایجاد شد."
else
  echo "نقش food_app از قبل وجود دارد (رمز قبلی حفظ شد)."
  APP_PASS="KEEP_EXISTING_OR_UPDATE_MANUALLY"
fi

DB_EXISTS="$(sudo -u postgres psql -Atqc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")"
if [[ "${DB_EXISTS}" != "1" ]]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER food_migrator ENCODING 'UTF8' TEMPLATE template0;"
  echo "دیتابیس ${DB_NAME} ایجاد شد."
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT CONNECT ON DATABASE ${DB_NAME} TO food_migrator, food_app;
GRANT CREATE, USAGE ON SCHEMA public TO food_migrator;
GRANT USAGE ON SCHEMA public TO food_app;
SQL

echo "=== ۵. ایجاد فایل /etc/food/app.env (فقط در صورت عدم وجود) ==="
if [[ ! -f "${ENV_FILE}" ]]; then
  CSRF_HEX="$(openssl rand -hex 32)"
  PEPPER_HEX="$(openssl rand -hex 32)"
  SETUP_HEX="$(openssl rand -hex 16)"

  cat >"${ENV_FILE}" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${API_PORT}
PUBLIC_BASE_URL=${PUBLIC_URL}
LOG_LEVEL=info
TRUSTED_PROXY_HOPS=1
BODY_LIMIT_BYTES=6291456

DATABASE_URL=postgres://food_app:${APP_PASS}@127.0.0.1:5432/${DB_NAME}?sslmode=disable
DATABASE_MIGRATOR_URL=postgres://food_migrator:${MIGRATOR_PASS}@127.0.0.1:5432/${DB_NAME}?sslmode=disable
DB_APP_ROLE=food_app
DB_MIGRATOR_ROLE=food_migrator
DATABASE_POOL_MAX=12

CSRF_SECRET=${CSRF_HEX}
NATIONAL_ID_PEPPER=${PEPPER_HEX}
DATA_ENCRYPTION_KEY=
SETUP_CODE=${SETUP_HEX}

SESSION_TTL_STUDENT_HOURS=12
SESSION_TTL_STAFF_HOURS=8
SESSION_ABSOLUTE_MAX_HOURS=168
SESSION_COOKIE_NAME=__Host-sid

ONLINE_PAYMENT_ENABLED=false
ZARINPAL_MERCHANT_ID=
ALLOW_SANDBOX_GATEWAY=false

SMS_PROVIDER=console
KAVENEGAR_API_KEY=
KAVENEGAR_SENDER=
SMS_MAX_ATTEMPTS=3

SERVE_STATIC=true
WEB_DIST_PATH=/opt/food/current/apps/web/dist
UPLOAD_DIR=/opt/food/shared/uploads
FOOD_IMAGE_MAX_BYTES=2097152
SHARP_DISABLE=false

BACKUP_AGE_RECIPIENT=
BACKUP_RETENTION_DAYS=14
BACKUP_RSYNC_TARGET=
BACKUP_SCP_TARGET=
EOF

  chown root:food "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  echo "فایل ${ENV_FILE} با مجوز 0640 ساخته شد (تنظیمات PUBLIC_BASE_URL و ZARINPAL_MERCHANT_ID را پیش از بهره‌برداری بازبینی کنید)."
else
  chown root:food "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  echo "فایل ${ENV_FILE} از قبل موجود بود و دست‌نخورده باقی ماند."
fi

echo "=== ۶. نصب واحدهای systemd و تایمرهای پشتیبان‌گیری، تمرین بازیابی و پایش سلامت ==="
install -m 0644 "${SCRIPT_DIR}/systemd/food-api.service" /etc/systemd/system/food-api.service
install -m 0644 "${SCRIPT_DIR}/systemd/food-worker.service" /etc/systemd/system/food-worker.service
install -m 0644 "${SCRIPT_DIR}/systemd/food-backup.service" /etc/systemd/system/food-backup.service
install -m 0644 "${SCRIPT_DIR}/systemd/food-backup.timer" /etc/systemd/system/food-backup.timer
install -m 0644 "${SCRIPT_DIR}/systemd/food-restore-drill.service" /etc/systemd/system/food-restore-drill.service
install -m 0644 "${SCRIPT_DIR}/systemd/food-restore-drill.timer" /etc/systemd/system/food-restore-drill.timer
install -m 0644 "${SCRIPT_DIR}/systemd/food-health.service" /etc/systemd/system/food-health.service
install -m 0644 "${SCRIPT_DIR}/systemd/food-health.timer" /etc/systemd/system/food-health.timer
install -m 0644 "${SCRIPT_DIR}/logrotate/food" /etc/logrotate.d/food

install -m 0750 "${SCRIPT_DIR}/backup.sh" "${FOOD_ROOT}/backup.sh"
install -m 0750 "${SCRIPT_DIR}/restore-drill.sh" "${FOOD_ROOT}/restore-drill.sh"
install -m 0750 "${SCRIPT_DIR}/healthcheck.sh" "${FOOD_ROOT}/healthcheck.sh"

systemctl daemon-reload
systemctl enable food-api.service food-worker.service food-backup.timer food-restore-drill.timer food-health.timer

echo "=== آماده‌سازی اولیه کامل شد. اکنون بستهٔ انتشار را با deploy/deploy.sh مستقر کنید. ==="
