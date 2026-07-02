#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_URL="http://127.0.0.1:${COPETS_BACKEND_PORT:-47322}/health"
BACKEND_LOG="${COPETS_BACKEND_LOG:-/tmp/copets-backend-development.log}"

backend_pid=""

cleanup() {
  if [[ -n "${backend_pid}" ]] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

backend_is_ready() {
  curl -fsS --max-time 1 "${BACKEND_URL}" >/dev/null 2>&1
}

if backend_is_ready; then
  echo "Copets development backend is already running at ${BACKEND_URL}."
else
  echo "Starting Copets development backend..."
  (
    cd "${ROOT_DIR}"
    exec scripts/start-backend-development.sh
  ) >"${BACKEND_LOG}" 2>&1 &
  backend_pid="$!"

  for _ in {1..30}; do
    if backend_is_ready; then
      break
    fi
    if ! kill -0 "${backend_pid}" 2>/dev/null; then
      echo "Backend exited before becoming ready. Log:"
      tail -n 80 "${BACKEND_LOG}" || true
      exit 1
    fi
    sleep 0.5
  done

  if ! backend_is_ready; then
    echo "Backend did not become ready in time. Log:"
    tail -n 80 "${BACKEND_LOG}" || true
    exit 1
  fi

  echo "Copets development backend is ready at ${BACKEND_URL}."
  echo "Backend log: ${BACKEND_LOG}"
fi

echo "Starting Copets macOS development app..."
cd "${ROOT_DIR}"
exec scripts/run-macos-development.sh
