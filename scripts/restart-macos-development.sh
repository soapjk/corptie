#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
APP_BIN="${ROOT_DIR}/apps/macos/.build/debug/CorptieMac"
EXTERNAL_RUNTIME_ROOT="${CORPTIE_DEVELOPMENT_RUNTIME_ROOT:-/Volumes/T9/CorptieData/development-launcher}"
if [[ "${EXTERNAL_RUNTIME_ROOT}" != /Volumes/* ]]; then
  echo "Development runtime root must be an explicitly configured external volume path." >&2
  exit 1
fi
WORKTREE_HASH="$(printf '%s' "${ROOT_DIR}" | shasum -a 256 | awk '{print substr($1,1,24)}')"
WORKTREE_RUNTIME_ROOT="${EXTERNAL_RUNTIME_ROOT}/worktrees/${WORKTREE_HASH}"
LEGACY_APP_LAUNCH_LABEL="com.corptie.mac.development.${WORKTREE_HASH}"
LEGACY_BACKEND_LAUNCH_LABEL="com.corptie.backend.development.${WORKTREE_HASH}"
APP_LOG="${CORPTIE_APP_LOG:-${WORKTREE_RUNTIME_ROOT}/logs/app.log}"
BACKEND_LOG="${CORPTIE_BACKEND_LOG:-${WORKTREE_RUNTIME_ROOT}/logs/backend.log}"
DEVELOPMENT_DATA_ROOT="${CORPTIE_DEVELOPMENT_DATA_ROOT:-${WORKTREE_RUNTIME_ROOT}/backend-data}"
RUN_ISOLATION_DATA_ROOT="${CORPTIE_RUN_ISOLATION_DATA_ROOT:-${WORKTREE_RUNTIME_ROOT}/run-isolation}"
PRESENTATION_DATA_DIR="${WORKTREE_RUNTIME_ROOT}/presentation"
USER_DEFAULTS_SUITE="com.corptie.development.${WORKTREE_HASH}"
BACKEND_PORT="${CORPTIE_DEVELOPMENT_BACKEND_PORT:-47322}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}/health"
PRODUCTION_BACKEND_PORT=47321

PRODUCTION_BACKEND_PID_BEFORE="$(lsof -tiTCP:"${PRODUCTION_BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"

mkdir -p "$(dirname "${APP_LOG}")" "${PRESENTATION_DATA_DIR}" "${DEVELOPMENT_DATA_ROOT}" \
  "${RUN_ISOLATION_DATA_ROOT}"

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
echo "Building Corptie backend native safety module..."
npm --prefix "${ROOT_DIR}/apps/backend" run build:native

echo "Stopping existing CorptieMac processes..."
# One-time cleanup for Development jobs registered by older revisions. Nothing
# below registers a replacement launchd job.
launchctl bootout "gui/$(id -u)/${LEGACY_APP_LAUNCH_LABEL}" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/${LEGACY_BACKEND_LAUNCH_LABEL}" >/dev/null 2>&1 || true
app_pids=()
while IFS= read -r pid; do
  [[ -n "${pid}" ]] || continue
  process_command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  process_cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [[ "${process_cwd}" == "${ROOT_DIR}" && "${process_command}" == *"apps/macos/.build/debug/CorptieMac"* ]]; then
    app_pids+=("${pid}")
  fi
done < <(pgrep -x CorptieMac 2>/dev/null || true)
if (( ${#app_pids[@]} > 0 )); then
  stop_pids "CorptieMac" "${app_pids[@]}"
fi

echo "Stopping existing Corptie development backend processes..."
backend_pids=()
while IFS= read -r pid; do
  [[ -n "${pid}" ]] || continue
  process_cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  process_command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  if [[ "${process_cwd}" == "${ROOT_DIR}/apps/backend" && "${process_command}" == *"node src/server.mjs"* ]]; then
    backend_pids+=("${pid}")
  fi
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

echo "Starting CorptieMac..."
/usr/bin/env \
  PATH="${PATH}" \
  CORPTIE_ENV=development \
  CORPTIE_BACKEND_PORT="${BACKEND_PORT}" \
  CORPTIE_DATA_ROOT="${DEVELOPMENT_DATA_ROOT}" \
  CORPTIE_RUN_ISOLATION_DATA_ROOT="${RUN_ISOLATION_DATA_ROOT}" \
  CORPTIE_DEVELOPMENT_BACKEND_LAUNCHER="${ROOT_DIR}/scripts/start-backend-development.sh" \
  CORPTIE_DEVELOPMENT_BACKEND_LOG="${BACKEND_LOG}" \
  CORPTIE_USER_DEFAULTS_SUITE="${USER_DEFAULTS_SUITE}" \
  CORPTIE_PRESENTATION_DATA_DIR="${PRESENTATION_DATA_DIR}" \
  /usr/bin/python3 "${ROOT_DIR}/scripts/launch-development-detached.py" "${APP_BIN}" "${APP_LOG}" &
APP_PID="$!"
for _ in {1..30}; do
  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ -z "${APP_PID}" ]] || ! kill -0 "${APP_PID}" 2>/dev/null; then
  echo "CorptieMac exited before becoming ready. Log:"
  tail -n 80 "${APP_LOG}" || true
  exit 1
fi

# CorptieMac owns the backend as a direct child Process and starts it during
# applicationDidFinishLaunching.
for _ in {1..30}; do
  if curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1; then
  echo "App-owned backend did not become ready in time. Log:"
  tail -n 80 "${BACKEND_LOG}" || true
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
echo "App diagnostics: macOS unified log (process CorptieMac)"
