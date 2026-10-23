#!/usr/bin/env bash
# ============================================================================
# deploy/healthcheck.sh — پایش دوره‌ای سلامت food-api و food-worker
# ============================================================================
set -euo pipefail

ENV_FILE="/etc/food/app.env"
API_PORT="3101"
if [[ -r "${ENV_FILE}" ]]; then
  PORT_LINE="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  if [[ -n "${PORT_LINE}" ]]; then
    API_PORT="${PORT_LINE}"
  fi
fi

if ! curl -fsS --max-time 5 "http://127.0.0.1:${API_PORT}/api/ready" >/dev/null; then
  logger -p daemon.err -t food-health "ALERT: سرویس food-api در پورت ${API_PORT} آماده نیست!"
  exit 1
fi

if ! systemctl is-active --quiet food-worker.service; then
  logger -p daemon.err -t food-health "ALERT: سرویس food-worker متوقف شده است!"
  exit 1
fi
