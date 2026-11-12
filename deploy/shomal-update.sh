#!/usr/bin/env bash
# به‌روزرسانی سایت diningshomal.ir (سرویس shomal-dining، پورت 3101)
# اجرا با root:  bash /opt/shomal-dining/deploy/shomal-update.sh
# فقط همین سایت را تغییر می‌دهد؛ سایت‌ها و دیتابیس‌های دیگر دست نمی‌خورند.
set -euo pipefail

BASE=/opt/shomal-dining
SERVICE=shomal-dining
DROPIN=/etc/systemd/system/$SERVICE.service.d/release.conf
ENVF=/etc/shomal-dining/app.env
HTTPDOCS=/var/www/vhosts/diningshomal.ir/httpdocs
WEB=apps/north-university-food-automation
STAMP=$(date +%Y%m%d%H%M)
REL=/opt/shomal-dining-r$STAMP
BK=/root/shomal-backup-$STAMP

echo "== ۱) دریافت کد جدید از GitHub"
cd "$BASE"
git fetch origin
git log --oneline -1 origin/main
git worktree add --detach "$REL" origin/main

echo "== ۲) نصب وابستگی‌ها و ساخت (سایت فعلی هنوز روشن است)"
cd "$REL"
npm install --no-audit --no-fund
npm run build
npm run build:standalone -w "$WEB"
test -f apps/api/dist/server.js
test -f "$WEB/dist-web/index.html"

echo "== ۳) پشتیبان‌گیری از تنظیمات و فایل‌های وب"
mkdir -p "$BK"
cp "$DROPIN" "$BK/release.conf"
cp "$ENVF" "$BK/app.env"
cp -a "$HTTPDOCS" "$BK/httpdocs"
readlink -f /proc/$(systemctl show -p MainPID --value $SERVICE)/cwd > "$BK/prev-cwd.txt" || true

echo "== ۴) سوییچ سرویس روی نسخه‌ی جدید"
printf '[Service]\nWorkingDirectory=%s/apps/api\n' "$REL" > "$DROPIN"
sed -i "s#^WEB_DIST_PATH=.*#WEB_DIST_PATH=$REL/$WEB/dist-web#" "$ENVF"
chmod -R o+rX "$REL"
systemctl daemon-reload
systemctl restart $SERVICE

echo "== ۵) به‌روزرسانی فایل‌های وب در Plesk"
rsync -a --delete --exclude .htaccess "$REL/$WEB/dist-web/" "$HTTPDOCS/"

echo "== ۶) بررسی سلامت"
ok=0
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3101/api/v1/public/info >/dev/null; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "!! سرویس بالا نیامد؛ بازگشت به نسخه‌ی قبلی..."
  cp "$BK/release.conf" "$DROPIN"
  cp "$BK/app.env" "$ENVF"
  rsync -a --delete "$BK/httpdocs/" "$HTTPDOCS/"
  systemctl daemon-reload && systemctl restart $SERVICE
  journalctl -u $SERVICE -n 40 --no-pager
  exit 1
fi

echo "✓ نسخه‌ی جدید فعال شد: $REL"
echo "  پشتیبان: $BK"
echo "  بازگشت دستی:  bash $BASE/deploy/shomal-rollback.sh $BK"
