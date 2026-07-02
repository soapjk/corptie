#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${ROOT_DIR}/apps/macos/.build/arm64-apple-macosx/debug/CopetsMac"
APP_LOG="${COPETS_APP_LOG:-/private/tmp/copets-dev/app.log}"

mkdir -p "$(dirname "${APP_LOG}")"

echo "Building Copets macOS development app..."
swift build --package-path "${ROOT_DIR}/apps/macos"

echo "Stopping existing CopetsMac processes..."
pkill -f "${APP_BIN}" 2>/dev/null || true
pkill -x "CopetsMac" 2>/dev/null || true

sleep 0.4

echo "Starting CopetsMac..."
COPETS_ENV=development \
COPETS_BACKEND_PORT="${COPETS_BACKEND_PORT:-47322}" \
"${APP_BIN}" >"${APP_LOG}" 2>&1 &

echo "CopetsMac started with pid $!"
echo "Log: ${APP_LOG}"
