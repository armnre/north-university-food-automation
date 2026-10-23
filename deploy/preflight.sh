#!/usr/bin/env bash
# ============================================================================
# deploy/preflight.sh — بررسی غیرتخریبی پیش‌نیازهای سرور دانشگاه شمال
# هیچ تغییر یا ری‌استارتی روی سرویس‌های فعلی (Plesk، nginx، PostgreSQL، shomaldoc) اعمال نمی‌کند.
# ============================================================================
set -euo pipefail

API_PORT="${PORT:-3101}"
NODE_BIN="${FOOD_NODE_BIN:-/opt/food/node/current/bin/node}"
RELEASE_DIR="${FOOD_RELEASE_DIR:-/opt/food/current}"

pass() { printf '  [OK]   %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

FAILURES=0

echo "=== ۱. سیستم‌عامل، زمان و منابع سخت‌افزاری ==="
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  pass "سیستم‌عامل: ${PRETTY_NAME:-unknown}"
else
  warn "/etc/os-release یافت نشد"
fi

TZ_CUR="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
if [[ "$TZ_CUR" == "Asia/Tehran" ]]; then
  pass "منطقهٔ زمانی سرور: $TZ_CUR"
else
  warn "منطقهٔ زمانی سرور '$TZ_CUR' است (پیشنهاد: Asia/Tehran؛ البته کد برنامه صراحتاً با Asia/Tehran محاسبه می‌کند)"
fi

FREE_GB="$(df -BG /opt 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}' || echo 0)"
if [[ "${FREE_GB:-0}" -ge 10 ]]; then
  pass "فضای خالی دیسک روی /opt: حدود ${FREE_GB}GB"
else
  fail "فضای خالی دیسک روی /opt کمتر از ۱۰ گیگابایت است (${FREE_GB}GB)"
fi

CPU_MODEL="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | xargs || echo unknown)"
HAS_AVX2="$(grep -m1 -o 'avx2' /proc/cpuinfo 2>/dev/null || true)"
pass "پردازنده: $CPU_MODEL (AVX2=${HAS_AVX2:-no})"
if [[ -z "$HAS_AVX2" ]]; then
  warn "پردازنده فاقد AVX2 است (مثلاً Xeon E5-2670 Sandy Bridge)؛ ماژول‌های بومی argon2 و sharp در ادامه تست می‌شوند."
fi

echo "=== ۲. بررسی عدم تداخل پورت‌ها و سرویس‌های همسایه ==="
if ss -ltn "( sport = :${API_PORT} )" | grep -q ":${API_PORT}"; then
  warn "پورت ${API_PORT} هم‌اکنون در حال شنود است (اگر سرویس food-api قبلاً نصب شده طبیعی است؛ بررسی کنید):"
  ss -ltnp "( sport = :${API_PORT} )" 2>/dev/null || true
else
  pass "پورت داخلی 127.0.0.1:${API_PORT} آزاد است"
fi

if ss -ltn '( sport = :3080 )' | grep -q ':3080'; then
  pass "سرویس همسایه روی پورت 3080 (shomaldoc) فعال و دست‌نخورده است"
fi

echo "=== ۳. بررسی PostgreSQL محلی (بدون تغییر دیتابیس‌ها) ==="
if ss -ltn '( sport = :5432 )' | grep -q ':5432'; then
  pass "PostgreSQL روی پورت 5432 در حال اجراست"
else
  fail "پورت 5432 فعال نیست؛ سرویس postgresql را بررسی کنید"
fi

if command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
  PG_VER="$(sudo -u postgres psql -Atqc 'SHOW server_version;' 2>/dev/null || echo unknown)"
  pass "نسخهٔ PostgreSQL: ${PG_VER}"
fi

echo "=== ۴. بررسی Node.js اختصاصی ۲۲ و ماژول‌های بومی (argon2 / sharp) ==="
if [[ -x "$NODE_BIN" ]]; then
  NODE_VER="$("$NODE_BIN" -v)"
  if [[ "$NODE_VER" =~ ^v2[2-9]\. ]]; then
    pass "باینری اختصاصی Node.js یافت شد: $NODE_BIN ($NODE_VER)"
  else
    fail "نسخهٔ Node.js در $NODE_BIN باید >=22 باشد (فعلی: $NODE_VER)"
  fi

  if [[ -d "$RELEASE_DIR/node_modules" ]]; then
    if (cd "$RELEASE_DIR" && "$NODE_BIN" -e "import('argon2').then(m => m.default.hash('test')).then(() => process.exit(0))" >/dev/null 2>&1); then
      pass "تست اجرای واقعی argon2 روی CPU سرور موفقیت‌آمیز بود"
    else
      fail "خطا در بارگذاری یا اجرای argon2 روی CPU این سرور!"
    fi

    if (cd "$RELEASE_DIR" && "$NODE_BIN" -e "import('sharp').then(m => m.default({create:{width:2,height:2,channels:3,background:{r:0,g:0,b:0}}}).png().toBuffer()).then(() => process.exit(0))" >/dev/null 2>&1); then
      pass "تست اجرای واقعی sharp روی CPU سرور موفقیت‌آمیز بود"
    else
      warn "باینری sharp روی این CPU قابل اجرا نیست؛ متغیر SHARP_DISABLE=true را در /etc/food/app.env قرار دهید تا مسیر امن fallback فعال شود."
    fi
  else
    warn "نسخهٔ استقراریافته در $RELEASE_DIR هنوز وجود ندارد؛ تست argon2/sharp پس از استخراج بسته در deploy.sh انجام خواهد شد."
  fi
else
  warn "باینری $NODE_BIN هنوز نصب نشده است (توسط provision.sh نصب می‌شود)."
fi

echo "=== ۵. بررسی nginx و Plesk ==="
if command -v nginx >/dev/null 2>&1; then
  pass "باینری nginx موجود است ($(nginx -v 2>&1))"
else
  fail "nginx یافت نشد"
fi
if command -v plesk >/dev/null 2>&1; then
  pass "ابزار مدیریتی Plesk شناسایی شد"
else
  warn "ابزار Plesk در PATH نیست (در صورت سرور غیر Plesk نادیده بگیرید)"
fi

echo "=== ۶. بررسی ابزار رمزنگاری بکاپ (age) و مقصد پشتیبان خارج از سرور ==="
ENV_FILE="${FOOD_ENV_FILE:-/etc/food/app.env}"
if [[ -r "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

if command -v age >/dev/null 2>&1; then
  pass "ابزار رمزنگاری age نصب است ($(age --version 2>/dev/null || echo installed))"
else
  warn "ابزار age هنوز نصب نیست (توسط provision.sh یا با دستور apt-get install -y age نصب می‌شود)"
fi

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  if [[ "${BACKUP_AGE_RECIPIENT}" =~ ^age1[0-9a-z]{58}$ ]]; then
    pass "کلید عمومی رمزنگاری بکاپ (BACKUP_AGE_RECIPIENT) معتبر است"
  else
    fail "فرمت BACKUP_AGE_RECIPIENT نامعتبر است (باید کلید عمومی age1... باشد)"
  fi
else
  warn "متغیر BACKUP_AGE_RECIPIENT هنوز در ${ENV_FILE} تنظیم نشده است (پیش از فعال‌سازی بکاپ شبانه الزامی است)"
fi

PRIV_PREFIX="AGE-SECRET-KEY-"
if { [[ -d /etc/food ]] && grep -rqF "${PRIV_PREFIX}" /etc/food 2>/dev/null; } ||
   { [[ -d /var/backups/food ]] && grep -rqF "${PRIV_PREFIX}" /var/backups/food 2>/dev/null; }; then
  fail "کلید خصوصی age روی سرور شناسایی شد! کلید خصوصی هرگز نباید روی سرور نگهداری شود."
fi

if [[ -n "${BACKUP_RSYNC_TARGET:-}" || -n "${BACKUP_SCP_TARGET:-}" ]]; then
  pass "مقصد انتقال پشتیبان به خارج از سرور تنظیم شده است"
else
  warn "مقصد انتقال خارج از سرور (BACKUP_RSYNC_TARGET / BACKUP_SCP_TARGET) تنظیم نشده است — بدون نسخه‌ی خارج از سرور، بکاپ ناقص است!"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "نتیجه: $FAILURES مورد خطای بحرانی شناسایی شد." >&2
  exit 1
fi

echo "نتیجه: بررسی پیش‌نیازها بدون خطای بحرانی کامل شد."
