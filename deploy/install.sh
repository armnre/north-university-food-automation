#!/usr/bin/env bash
# نصب اولیه‌ی سامانه رزرو غذا روی سرور Ubuntu + Plesk — فقط یک‌بار اجرا شود.
# فقط به این موارد دست می‌زند: کاربر لینوکس foodapp، پوشه /opt/food-automation، دیتابیس food_automation،
# دو سرویس systemd (food-api, food-worker) و تنظیمات nginx همان یک دامنه در Plesk. به سایت‌های دیگر کاری ندارد.
#
# استفاده:  sudo DOMAIN=food.example.ac.ir bash deploy/install.sh
set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN را تعیین کنید، مثلاً DOMAIN=food.example.ac.ir}"
REPO="${REPO:-https://github.com/armnre/north-university-food-automation.git}"
BRANCH="${BRANCH:-main}"
APP_USER="${APP_USER:-foodapp}"
APP_DIR="${APP_DIR:-/opt/food-automation}"
PORT="${PORT:-3101}"
DB_NAME="${DB_NAME:-food_automation}"
VHOST_ROOT="/var/www/vhosts/${DOMAIN}"
DOCROOT="${DOCROOT:-${VHOST_ROOT}/httpdocs}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "با sudo اجرا کنید."
[ -d "$VHOST_ROOT" ] || die "دامنه‌ی ${DOMAIN} در Plesk پیدا نشد (${VHOST_ROOT}). اول دامنه را در Plesk بسازید."

log "۱) پیش‌نیازها (Node 22، PostgreSQL، git، rsync)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  # Node از مخزن رسمی NodeSource؛ روی Node های Plesk (/opt/plesk/node) اثری ندارد.
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git rsync curl
command -v psql >/dev/null || apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

log "۲) کاربر لینوکس و پوشه‌ها"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/${APP_USER}" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" /var/lib/food-automation/uploads /var/backups/food-automation
chown -R "$APP_USER":"$APP_USER" "$APP_DIR" /var/lib/food-automation /var/backups/food-automation

log "۳) دریافت کد"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

log "۴) دیتابیس و نقش‌ها (فقط روی localhost)"
ENV_FILE="/etc/food-automation.env"
if [ ! -f "$ENV_FILE" ]; then
  rnd() { openssl rand -hex "$1"; }
  APP_PW=$(rnd 24); MIG_PW=$(rnd 24)
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='food_migrator') THEN CREATE ROLE food_migrator LOGIN PASSWORD '${MIG_PW}'; ELSE ALTER ROLE food_migrator PASSWORD '${MIG_PW}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='food_app') THEN CREATE ROLE food_app LOGIN PASSWORD '${APP_PW}'; ELSE ALTER ROLE food_app PASSWORD '${APP_PW}'; END IF;
END \$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
    || sudo -u postgres createdb -O food_migrator "$DB_NAME"

  log "۵) فایل تنظیمات محرمانه ${ENV_FILE}"
  SETUP_CODE=$(rnd 12)
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${PORT}
PUBLIC_BASE_URL=https://${DOMAIN}
TRUSTED_PROXY_HOPS=1
DATABASE_URL=postgres://food_app:${APP_PW}@127.0.0.1:5432/${DB_NAME}
MIGRATOR_DATABASE_URL=postgres://food_migrator:${MIG_PW}@127.0.0.1:5432/${DB_NAME}
DATABASE_POOL_MAX=10
NATIONAL_ID_PEPPER=$(rnd 32)
CSRF_SECRET=$(rnd 32)
SETUP_CODE=${SETUP_CODE}
UPLOAD_DIR=/var/lib/food-automation/uploads
BODY_LIMIT_BYTES=11534336
ONLINE_PAYMENT_ENABLED=false
PAYMENT_PROVIDER=saman
SAMAN_TERMINAL_ID=15321785
ALLOW_SANDBOX_GATEWAY=false
SMS_PROVIDER=console
EOF
  chmod 640 "$ENV_FILE"; chown root:"$APP_USER" "$ENV_FILE"
  echo "کد راه‌اندازی اولین مدیر (SETUP_CODE): ${SETUP_CODE}"
  echo "⚠ از فایل ${ENV_FILE} حتماً نسخه‌ی پشتیبان امن بگیرید؛ NATIONAL_ID_PEPPER نباید هرگز عوض شود."
else
  echo "${ENV_FILE} از قبل وجود دارد؛ دست نخورد."
fi

log "۶) سرویس‌های systemd"
for unit in api worker; do
  script=$([ "$unit" = api ] && echo server || echo worker)
  cat > "/etc/systemd/system/food-${unit}.service" <<EOF
[Unit]
Description=Food automation ${unit}
After=network.target postgresql.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}/apps/api
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node dist/${script}.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/food-automation

[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
systemctl enable food-api food-worker

log "۷) تنظیم nginx فقط برای دامنه‌ی ${DOMAIN} در Plesk"
CONF_DIR="/var/www/vhosts/system/${DOMAIN}/conf"
mkdir -p "$CONF_DIR"
VHOST_NGINX="${CONF_DIR}/vhost_nginx.conf"
[ -f "$VHOST_NGINX" ] && cp "$VHOST_NGINX" "${VHOST_NGINX}.bak.$(date +%s)"
cp "${APP_DIR}/deploy/nginx-directives.conf" "$VHOST_NGINX"
sed -i "s/__PORT__/${PORT}/g" "$VHOST_NGINX"
if command -v plesk >/dev/null; then
  plesk sbin httpdmng --reconfigure-domain "$DOMAIN"
fi

log "۸) اولین build و راه‌اندازی"
DOMAIN="$DOMAIN" DOCROOT="$DOCROOT" APP_DIR="$APP_DIR" APP_USER="$APP_USER" bash "${APP_DIR}/deploy/update.sh" --no-pull

cat <<EOF

✅ نصب کامل شد.
- آدرس: https://${DOMAIN}   (SSL را در Plesk ← Domains ← ${DOMAIN} ← SSL/TLS با Let's Encrypt فعال کنید)
- ساخت اولین مدیر: در مرورگر وارد سایت شوید و با SETUP_CODE بالا مدیر کل را بسازید،
  یا روی سرور: sudo -u ${APP_USER} bash -c 'set -a; . ${ENV_FILE}; cd ${APP_DIR}/apps/api && node dist/cli/create-admin.js'
- به‌روزرسانی‌های بعدی:  sudo DOMAIN=${DOMAIN} bash ${APP_DIR}/deploy/update.sh
EOF
