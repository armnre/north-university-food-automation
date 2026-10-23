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

echo "=== ۳. نصب ایزولهٔ Node.js 22 LTS در /opt/food/node/current ==="
if [[ -x "${FOOD_ROOT}/node/current/bin/node" ]] && "${FOOD_ROOT}/node/current/bin/node" -v | grep -qE '^v2[2-9]\.'; then
  echo "Node.js 22 قبلاً نصب شده است: $("${FOOD_ROOT}/node/current/bin/node" -v)"
else
  if [[ -n "${NODE_TARBALL}" && -f "${NODE_TARBALL}" ]]; then
    echo "نصب Node.js 22 از فایل آرشیو محلی: ${NODE_TARBALL}"
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
    DOWNLOAD_URL="${NODE_MIRROR_URL:-https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}}"
    echo "دانلود Node.js ${NODE_VERSION} از ${DOWNLOAD_URL} ..."
    echo "نکته: اگر سرور دسترسی مستقیم به nodejs.org ندارد، فایل ${ARCHIVE} را به سرور منتقل کرده و با NODE_TARBALL=/path/to/${ARCHIVE} اجرا کنید."
    TMP_ARCHIVE="$(mktemp "/tmp/${ARCHIVE}.XXXXXX")"
    curl -fsSL --connect-timeout 15 --max-time 300 "${DOWNLOAD_URL}" -o "${TMP_ARCHIVE}"
    DEST_NODE_DIR="${FOOD_ROOT}/node/node-${NODE_VERSION}-linux-x64"
    rm -rf "${DEST_NODE_DIR}"
    mkdir -p "${DEST_NODE_DIR}"
    tar -xJf "${TMP_ARCHIVE}" -C "${DEST_NODE_DIR}" --strip-components=1
    rm -f "${TMP_ARCHIVE}"
    ln -sfn "${DEST_NODE_DIR}" "${FOOD_ROOT}/node/current"
  fi
  echo "Node.js آماده شد: $("${FOOD_ROOT}/node/current/bin/node" -v)"
fi

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
