#!/usr/bin/env bash
# بازگشت به نسخه‌ی قبلی:  bash shomal-rollback.sh /root/shomal-backup-YYYYMMDDHHMM
set -euo pipefail
BK=${1:?مسیر پوشه‌ی پشتیبان را بدهید}
cp "$BK/release.conf" /etc/systemd/system/shomal-dining.service.d/release.conf
cp "$BK/app.env" /etc/shomal-dining/app.env
rsync -a --delete "$BK/httpdocs/" /var/www/vhosts/diningshomal.ir/httpdocs/
systemctl daemon-reload
systemctl restart shomal-dining
sleep 3
systemctl status shomal-dining --no-pager | head -5
