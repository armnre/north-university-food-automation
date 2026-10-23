#!/usr/bin/env bash
# ============================================================================
# deploy/build-release.sh — ساخت بستهٔ انتشار ازپیش‌کامپایل‌شده (بدون نیاز به اینترنت روی سرور ایران)
# اجرا روی ایستگاه کاری توسعه‌دهنده یا GitHub Actions (لینوکس x86_64، Node 22).
# خروجی: food-release-<commit>.tar.gz
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

COMMIT_SHA="$(git rev-parse --short=10 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
OUT_FILE="${1:-${REPO_ROOT}/food-release-${COMMIT_SHA}.tar.gz}"
STAGE_DIR="$(mktemp -d /tmp/food-release-stage.XXXXXX)"

cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

echo "=== ۱. بررسی عدم وجود راز و ساخت کامل پروژه‌ها ==="
npm run secrets:check
npm run build

echo "=== ۲. آماده‌سازی محتویات بسته در ${STAGE_DIR} ==="
mkdir -p \
  "${STAGE_DIR}/packages/shared" \
  "${STAGE_DIR}/packages/components" \
  "${STAGE_DIR}/apps/api" \
  "${STAGE_DIR}/apps/web" \
  "${STAGE_DIR}/scripts" \
  "${STAGE_DIR}/deploy"

cp package.json package-lock.json "${STAGE_DIR}/"
cp scripts/fix-workspace-hoisting.mjs "${STAGE_DIR}/scripts/"
cp -R deploy/* "${STAGE_DIR}/deploy/"

cp packages/shared/package.json "${STAGE_DIR}/packages/shared/"
cp -R packages/shared/dist "${STAGE_DIR}/packages/shared/dist"

cp packages/components/package.json "${STAGE_DIR}/packages/components/"

cp apps/api/package.json "${STAGE_DIR}/apps/api/"
cp -R apps/api/dist "${STAGE_DIR}/apps/api/dist"
cp -R apps/api/drizzle "${STAGE_DIR}/apps/api/drizzle"

cp apps/web/package.json "${STAGE_DIR}/apps/web/"
cp -R apps/web/dist "${STAGE_DIR}/apps/web/dist"

echo "=== ۳. نصب وابستگی‌های صرفاً تولیدی (omit=dev) داخل بسته ==="
(
  cd "${STAGE_DIR}"
  HUSKY=0 npm ci --omit=dev --ignore-scripts
  # بازسازی ماژول‌های بومی برای لینوکس x64 (argon2 و sharp)
  npm rebuild argon2 sharp
  node scripts/fix-workspace-hoisting.mjs
)

echo "${COMMIT_SHA}" > "${STAGE_DIR}/RELEASE_SHA"

echo "=== ۴. فشرده‌سازی بسته در ${OUT_FILE} ==="
tar -czf "${OUT_FILE}" -C "${STAGE_DIR}" .
ls -lh "${OUT_FILE}"
echo "بستهٔ آمادهٔ انتقال به سرور ساخته شد: ${OUT_FILE}"
