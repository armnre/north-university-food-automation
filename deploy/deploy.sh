#!/usr/bin/env bash
# ============================================================================
# deploy/deploy.sh — استقرار اتمیک با قابلیت بازگشت خودکار (Rollback)
#
# روش ۱ (پیش‌فرض و توصیه‌شده برای سرور ایران — بدون نیاز به اینترنت سرور):
#   sudo ./deploy/deploy.sh --tarball /tmp/food-release-xxxxxxx.tar.gz
#
# روش ۲ (ساخت مستقیم از مخزن در صورت برقراری دسترسی سرور به GitHub و npm):
#   sudo ./deploy/deploy.sh --git /path/to/cloned/repo
# ============================================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "این اسکریپت باید با دسترسی root (sudo) اجرا شود." >&2
  exit 1
fi

MODE=""
SOURCE_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tarball)
      MODE="tarball"
      SOURCE_PATH="${2:-}"
      shift 2
      ;;
    --git)
      MODE="git"
      SOURCE_PATH="${2:-}"
      shift 2
      ;;
    *)
      echo "پارامتر نامعتبر: $1" >&2
      echo "استفاده: sudo $0 --tarball <release.tar.gz> | --git <repo_dir>" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${MODE}" || -z "${SOURCE_PATH}" ]]; then
  echo "استفاده: sudo $0 --tarball <release.tar.gz> | --git <repo_dir>" >&2
  exit 1
fi

FOOD_ROOT="/opt/food"
RELEASES_DIR="${FOOD_ROOT}/releases"
CURRENT_LINK="${FOOD_ROOT}/current"
ENV_FILE="/etc/food/app.env"
NODE_BIN="${FOOD_ROOT}/node/current/bin/node"
NPM_BIN="${FOOD_ROOT}/node/current/bin/npm"
KEEP_RELEASES=5

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "فایل ${ENV_FILE} یافت نشد؛ ابتدا deploy/provision.sh را اجرا کنید." >&2
  exit 1
fi
if [[ ! -x "${NODE_BIN}" ]]; then
  echo "باینری Node.js در ${NODE_BIN} یافت نشد؛ ابتدا deploy/provision.sh را اجرا کنید." >&2
  exit 1
fi

PREV_TARGET=""
if [[ -L "${CURRENT_LINK}" ]]; then
  PREV_TARGET="$(readlink -f "${CURRENT_LINK}" || true)"
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
NEW_RELEASE="${RELEASES_DIR}/${TIMESTAMP}"
mkdir -p "${NEW_RELEASE}"

echo "=== ۱. آماده‌سازی نسخهٔ جدید در ${NEW_RELEASE} ==="
if [[ "${MODE}" == "tarball" ]]; then
  if [[ ! -f "${SOURCE_PATH}" ]]; then
    echo "فایل بسته یافت نشد: ${SOURCE_PATH}" >&2
    exit 1
  fi
  tar -xzf "${SOURCE_PATH}" -C "${NEW_RELEASE}"
else
  if [[ ! -d "${SOURCE_PATH}" ]]; then
    echo "مسیر مخزن یافت نشد: ${SOURCE_PATH}" >&2
    exit 1
  fi
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='.uploads' "${SOURCE_PATH}/" "${NEW_RELEASE}/"
  (
    cd "${NEW_RELEASE}"
    PATH="${FOOD_ROOT}/node/current/bin:${PATH}" HUSKY=0 "${NPM_BIN}" ci
    PATH="${FOOD_ROOT}/node/current/bin:${PATH}" "${NPM_BIN}" run build
    PATH="${FOOD_ROOT}/node/current/bin:${PATH}" HUSKY=0 "${NPM_BIN}" prune --omit=dev
  )
fi

chown -R root:root "${NEW_RELEASE}"
chmod -R a+rX "${NEW_RELEASE}"

echo "=== ۲. بررسی سازگاری باینری‌های بومی (argon2 و sharp) روی پردازندهٔ سرور ==="
(
  cd "${NEW_RELEASE}"
  "${NODE_BIN}" -e "import('argon2').then(m => m.default.hash('preflight')).then(() => process.exit(0))"
)
echo "  [OK] argon2 با موفقیت اجرا شد."

if ! (cd "${NEW_RELEASE}" && "${NODE_BIN}" -e "import('sharp').then(m => m.default({create:{width:2,height:2,channels:3,background:{r:0,g:0,b:0}}}).png().toBuffer()).then(() => process.exit(0))" >/dev/null 2>&1); then
  echo "  [WARN] پردازندهٔ سرور دستورات موردنیاز باینری sharp را ندارد؛ مطمئن شوید SHARP_DISABLE=true در ${ENV_FILE} فعال است."
else
  echo "  [OK] sharp با موفقیت اجرا شد."
fi

echo "=== ۳. اجرای مهاجرت‌های پایگاه داده (food_migrator) و داده‌های پایه ==="
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

(
  cd "${NEW_RELEASE}"
  "${NODE_BIN}" apps/api/dist/cli/migrate.js
  "${NODE_BIN}" apps/api/dist/cli/seed.js
)

echo "=== ۴. جابه‌جایی اتمیک symlink به نسخهٔ جدید و راه‌اندازی مجدد سرویس‌های food ==="
ln -sfn "${NEW_RELEASE}" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"

systemctl restart food-api.service
systemctl restart food-worker.service

echo "=== ۵. بررسی سلامت سرویس (http://127.0.0.1:${PORT:-3101}/api/ready) ==="
READY_URL="http://127.0.0.1:${PORT:-3101}/api/ready"
HEALTHY=0
for _ in {1..15}; do
  if curl -fsS --max-time 3 "${READY_URL}" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "${HEALTHY}" -ne 1 ]]; then
  echo "خطا: سرویس جدید در بررسی سلامت پاسخ نداد!" >&2
  journalctl -u food-api.service -n 40 --no-pager >&2 || true
  if [[ -n "${PREV_TARGET}" && -d "${PREV_TARGET}" ]]; then
    echo "بازگشت خودکار (Rollback) به نسخهٔ قبلی: ${PREV_TARGET}" >&2
    ln -sfn "${PREV_TARGET}" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "${CURRENT_LINK}"
    systemctl restart food-api.service food-worker.service || true
  fi
  exit 1
fi

if ! systemctl is-active --quiet food-worker.service; then
  echo "خطا: سرویس food-worker فعال نماند!" >&2
  journalctl -u food-worker.service -n 40 --no-pager >&2 || true
  exit 1
fi

echo "=== ۶. پاک‌سازی نسخه‌های قدیمی (نگه‌داری ${KEEP_RELEASES} نسخهٔ آخر) ==="
# shellcheck disable=SC2012
ls -1dt "${RELEASES_DIR}"/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

echo "استقرار با موفقیت کامل انجام شد: $(curl -fsS "${READY_URL}")"
