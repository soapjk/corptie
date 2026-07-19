#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${ROOT_DIR}/apps/macos/.build/arm64-apple-macosx/debug/CorptieMac"
APP_LOG="${CORPTIE_APP_LOG:-/private/tmp/corptie-dev/app.log}"
BACKEND_LOG="${CORPTIE_BACKEND_LOG:-/private/tmp/corptie-dev/backend.log}"
BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47322}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}/health"
PRODUCTION_BACKEND_PORT=47321

PRODUCTION_BACKEND_PID_BEFORE="$(lsof -tiTCP:"${PRODUCTION_BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"

mkdir -p "$(dirname "${APP_LOG}")"

stop_pids() {
  local label="$1"
  shift
  local pids=("$@")
  if (( ${#pids[@]} == 0 )); then
    return
  fi

  echo "Stopping ${label}: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  for _ in {1..20}; do
    local alive=()
    for pid in "${pids[@]}"; do
      kill -0 "${pid}" 2>/dev/null && alive+=("${pid}")
    done
    if (( ${#alive[@]} == 0 )); then
      return
    fi
    sleep 0.1
  done

  echo "Force stopping ${label}: ${pids[*]}"
  kill -9 "${pids[@]}" 2>/dev/null || true
  for _ in {1..20}; do
    local still_alive=false
    for pid in "${pids[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        still_alive=true
      fi
    done
    [[ "${still_alive}" == false ]] && return
    sleep 0.1
  done

  echo "Unable to stop ${label}."
  exit 1
}

echo "Building Corptie macOS development app..."
swift build --package-path "${ROOT_DIR}/apps/macos"

echo "Stopping existing CorptieMac processes..."
launchctl remove com.corptie.mac.development 2>/dev/null || true
app_pids=()
while IFS= read -r pid; do
  [[ -n "${pid}" ]] && app_pids+=("${pid}")
done < <(pgrep -x CorptieMac 2>/dev/null || true)
if (( ${#app_pids[@]} > 0 )); then
  stop_pids "CorptieMac" "${app_pids[@]}"
fi

echo "Stopping existing Corptie development backend processes..."
launchctl remove com.corptie.backend.development 2>/dev/null || true
backend_pids=()
while IFS= read -r pid; do
  [[ -n "${pid}" ]] && backend_pids+=("${pid}")
done < <(lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null || true)
if (( ${#backend_pids[@]} > 0 )); then
  stop_pids "development backend" "${backend_pids[@]}"
fi

if lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${BACKEND_PORT} is still occupied."
  exit 1
fi

: >"${BACKEND_LOG}"
: >"${APP_LOG}"

echo "Starting Corptie development backend..."
(
  cd "${ROOT_DIR}"
  env CORPTIE_ENV=development CORPTIE_BACKEND_PORT="${BACKEND_PORT}" \
    "${ROOT_DIR}/scripts/start-backend-development.sh" >>"${BACKEND_LOG}" 2>&1
) &

for _ in {1..30}; do
  if curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1; then
  echo "Backend did not become ready in time. Log:"
  tail -n 80 "${BACKEND_LOG}" || true
  exit 1
fi

echo "Starting CorptieMac..."
env CORPTIE_ENV=development CORPTIE_BACKEND_PORT="${BACKEND_PORT}" \
  "${APP_BIN}" >>"${APP_LOG}" 2>&1 &

sleep 0.5
APP_PID="$(pgrep -x CorptieMac | head -1 || true)"
if [[ -z "${APP_PID}" ]]; then
  echo "CorptieMac exited before becoming ready. Log:"
  tail -n 80 "${APP_LOG}" || true
  exit 1
fi

osascript -e "tell application \"System Events\" to set frontmost of first process whose unix id is ${APP_PID} to true" 2>/dev/null || true

BACKEND_PID="$(lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN | head -1 || true)"
PRODUCTION_BACKEND_PID_AFTER="$(lsof -tiTCP:"${PRODUCTION_BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "${PRODUCTION_BACKEND_PID_BEFORE}" && "${PRODUCTION_BACKEND_PID_AFTER}" != "${PRODUCTION_BACKEND_PID_BEFORE}" ]]; then
  echo "Production backend changed during development restart (before=${PRODUCTION_BACKEND_PID_BEFORE}, after=${PRODUCTION_BACKEND_PID_AFTER:-stopped})."
  exit 1
fi
echo "Corptie backend started with pid ${BACKEND_PID}"
echo "Backend log: ${BACKEND_LOG}"
echo "CorptieMac started with pid ${APP_PID}"
echo "Log: ${APP_LOG}"
