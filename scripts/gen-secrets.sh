#!/usr/bin/env bash
# ============================================================================
# scripts/gen-secrets.sh — تولید کلیدهای تصادفی امن برای فایل .env / app.env
# استفاده:  ./scripts/gen-secrets.sh >> .env
# هشدار: NATIONAL_ID_PEPPER را پس از راه‌اندازی تولیدی هرگز تغییر ندهید.
# ============================================================================
set -euo pipefail
command -v openssl >/dev/null 2>&1 || { echo "openssl نصب نیست." >&2; exit 1; }
echo "CSRF_SECRET=$(openssl rand -hex 32)"
echo "NATIONAL_ID_PEPPER=$(openssl rand -hex 32)"
echo "DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "SETUP_CODE=$(openssl rand -hex 16)"
