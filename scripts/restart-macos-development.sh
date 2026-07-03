#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${ROOT_DIR}/apps/macos/.build/arm64-apple-macosx/debug/CopetsMac"
APP_LOG="${COPETS_APP_LOG:-/private/tmp/copets-dev/app.log}"
BACKEND_LOG="${COPETS_BACKEND_LOG:-/private/tmp/copets-dev/backend.log}"
BACKEND_PORT="${COPETS_BACKEND_PORT:-47322}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}/health"

mkdir -p "$(dirname "${APP_LOG}")"

echo "Building Copets macOS development app..."
swift build --package-path "${ROOT_DIR}/apps/macos"

echo "Stopping existing CopetsMac processes..."
pkill -f "${APP_BIN}" 2>/dev/null || true
pkill -x "CopetsMac" 2>/dev/null || true

echo "Stopping existing Copets development backend processes..."
if command -v lsof >/dev/null 2>&1; then
  while read -r pid; do
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
  done < <(lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null || true)
fi
pkill -f "${ROOT_DIR}/apps/backend/src/server.mjs" 2>/dev/null || true
pkill -f "node src/server.mjs" 2>/dev/null || true

sleep 0.4

echo "Starting Copets development backend..."
(
  cd "${ROOT_DIR}"
  COPETS_ENV=development \
  COPETS_BACKEND_PORT="${BACKEND_PORT}" \
  exec scripts/start-backend-development.sh
) >"${BACKEND_LOG}" 2>&1 &
BACKEND_PID="$!"

for _ in {1..30}; do
  if curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "Backend exited before becoming ready. Log:"
    tail -n 80 "${BACKEND_LOG}" || true
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1; then
  echo "Backend did not become ready in time. Log:"
  tail -n 80 "${BACKEND_LOG}" || true
  exit 1
fi

echo "Starting CopetsMac..."
COPETS_ENV=development \
COPETS_BACKEND_PORT="${BACKEND_PORT}" \
"${APP_BIN}" >"${APP_LOG}" 2>&1 &

echo "Copets backend started with pid ${BACKEND_PID}"
echo "Backend log: ${BACKEND_LOG}"
echo "CopetsMac started with pid $!"
echo "Log: ${APP_LOG}"
