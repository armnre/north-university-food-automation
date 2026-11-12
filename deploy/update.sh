#!/usr/bin/env bash
# به‌روزرسانی خودکار: دریافت کد ← build ← بکاپ دیتابیس ← migration ← انتشار فرانت ← ری‌استارت ← health check.
# اگر هر مرحله شکست بخورد، نسخه‌ی قبلی (کد و فرانت) برمی‌گردد. فقط سرویس‌ها و پوشه‌ی همین سامانه را لمس می‌کند.
#
# استفاده:  sudo DOMAIN=food.example.ac.ir bash /opt/food-automation/deploy/update.sh
set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN را تعیین کنید}"
APP_USER="${APP_USER:-foodapp}"
APP_DIR="${APP_DIR:-/opt/food-automation}"
BRANCH="${BRANCH:-main}"
DOCROOT="${DOCROOT:-/var/www/vhosts/${DOMAIN}/httpdocs}"
ENV_FILE="/etc/food-automation.env"
BACKUP_DIR="/var/backups/food-automation"
WEB_APP="apps/north-university-food-automation"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "با sudo اجرا کنید."
as_app() { sudo -u "$APP_USER" -H bash -c "set -a; . ${ENV_FILE}; set +a; cd ${APP_DIR} && $*"; }

cd "$APP_DIR"
PREV=$(git rev-parse HEAD)
STAMP=$(date +%Y%m%d-%H%M%S)

rollback() {
  printf '\n\033[1;31m!! خطا — بازگشت به نسخه‌ی %s\033[0m\n' "$PREV"
  as_app "git reset --hard ${PREV} && npm ci --no-audit --no-fund && npm run build" || true
  [ -d "${BACKUP_DIR}/web-${STAMP}" ] && rsync -a --delete "${BACKUP_DIR}/web-${STAMP}/" "${DOCROOT}/" || true
  systemctl restart food-api food-worker || true
  echo "در صورت نیاز به بازگرداندن دیتابیس: ${BACKUP_DIR}/db-${STAMP}.dump (راهنما در docs/DEPLOY.md)"
  exit 1
}
trap rollback ERR

if [ "${1:-}" != "--no-pull" ]; then
  log "دریافت آخرین کد از شاخه‌ی ${BRANCH}"
  as_app "git fetch origin ${BRANCH} && git reset --hard origin/${BRANCH}"
fi
echo "نسخه: $(git log --oneline -1)"

log "نصب وابستگی‌ها و build بک‌اند"
as_app "npm ci --no-audit --no-fund && npm run build"

log "build فرانت (PWA مستقل)"
as_app "cd ${WEB_APP} && npx vite build --config vite.standalone.config.ts"

log "بکاپ دیتابیس"
mkdir -p "$BACKUP_DIR"
DB_NAME=$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -E 's#.*/([^/?]+).*#\1#')
sudo -u postgres pg_dump -Fc "$DB_NAME" > "${BACKUP_DIR}/db-${STAMP}.dump"
# نگه‌داری ۱۴ بکاپ آخر
ls -1t "${BACKUP_DIR}"/db-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f

log "migration دیتابیس"
as_app "cd apps/api && node dist/cli/migrate.js"

log "انتشار فرانت در ${DOCROOT}"
OWNER=$(stat -c '%U:%G' "$DOCROOT")
mkdir -p "${BACKUP_DIR}/web-${STAMP}"
rsync -a "${DOCROOT}/" "${BACKUP_DIR}/web-${STAMP}/"
rsync -a --delete --exclude '.well-known' "${APP_DIR}/${WEB_APP}/dist-web/" "${DOCROOT}/"
chown -R "$OWNER" "$DOCROOT"
ls -1dt "${BACKUP_DIR}"/web-* | tail -n +6 | xargs -r rm -rf

log "ری‌استارت سرویس‌ها"
systemctl restart food-api food-worker

log "بررسی سلامت"
PORT=$(grep '^PORT=' "$ENV_FILE" | cut -d= -f2)
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/ready" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "${ok:-}" = 1 ] || { journalctl -u food-api -n 40 --no-pager; false; }
systemctl is-active --quiet food-worker || { journalctl -u food-worker -n 40 --no-pager; false; }

trap - ERR
log "✅ به‌روزرسانی موفق: $(git log --oneline -1)"
