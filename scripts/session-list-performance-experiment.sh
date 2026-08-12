#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${ROOT_DIR}/apps/macos/.build/arm64-apple-macosx/debug/CorptieMac"
BACKEND_PORT="${CORPTIE_SESSION_PERF_BACKEND_PORT:-47321}"
RESULT_DIR="${CORPTIE_SESSION_PERF_RESULT_DIR:-/private/tmp/corptie-session-list-perf}"
DRAG_SECONDS="${CORPTIE_SESSION_PERF_DRAG_SECONDS:-6}"
SAMPLE_INTERVAL="${CORPTIE_SESSION_PERF_SAMPLE_INTERVAL:-0.25}"

mkdir -p "${RESULT_DIR}"

stop_development_app() {
  local pids=()
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && pids+=("${pid}")
  done < <(pgrep -x CorptieMac 2>/dev/null || true)
  if (( ${#pids[@]} > 0 )); then
    kill "${pids[@]}" 2>/dev/null || true
    for _ in {1..30}; do
      local alive=false
      for pid in "${pids[@]}"; do
        kill -0 "${pid}" 2>/dev/null && alive=true
      done
      [[ "${alive}" == false ]] && break
      sleep 0.1
    done
  fi
}

window_server_pid() {
  pgrep -x WindowServer | head -1
}

run_case() {
  local name="$1"
  local limit="$2"
  local halos="$3"
  local glass="$4"
  local polling="$5"
  local case_log="${RESULT_DIR}/${name}.app.log"
  local samples="${RESULT_DIR}/${name}.csv"

  stop_development_app
  : >"${case_log}"
  env \
    CORPTIE_ENV=development \
    CORPTIE_BACKEND_PORT="${BACKEND_PORT}" \
    CORPTIE_SESSION_PERF_LIMIT="${limit}" \
    CORPTIE_SESSION_PERF_HALO_ANIMATIONS="${halos}" \
    CORPTIE_SESSION_PERF_GLASS_EFFECTS="${glass}" \
    CORPTIE_SESSION_PERF_POLLING="${polling}" \
    CORPTIE_SESSION_PERF_FORCE_CARDS=1 \
    "${APP_BIN}" >>"${case_log}" 2>&1 &
  local app_pid=$!
  local ws_pid
  ws_pid="$(window_server_pid)"

  local ready=false
  for _ in {1..80}; do
    if swift "${ROOT_DIR}/scripts/macos-window-drag.swift" "${app_pid}" 1 \
      >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 0.25
  done
  if [[ "${ready}" != true ]]; then
    echo "Main window did not become ready for ${name}." >&2
    return 1
  fi
  sleep 4

  echo "case,sample,pid,cpu" >"${samples}"
  (
    local sample=0
    while kill -0 "${app_pid}" 2>/dev/null; do
      sample=$((sample + 1))
      ps -p "${app_pid},${ws_pid}" -o pid=,pcpu= | while read -r pid cpu; do
        echo "${name},${sample},${pid},${cpu}" >>"${samples}"
      done
      sleep "${SAMPLE_INTERVAL}"
    done
  ) &
  local sampler_pid=$!

  swift "${ROOT_DIR}/scripts/macos-window-drag.swift" "${app_pid}" "${DRAG_SECONDS}"
  sleep 1
  kill "${sampler_pid}" 2>/dev/null || true
  wait "${sampler_pid}" 2>/dev/null || true

  awk -F, -v app_pid="${app_pid}" -v ws_pid="${ws_pid}" '
    NR > 1 && $3 == app_pid { app_sum += $4; app_count++; if ($4 > app_max) app_max = $4 }
    NR > 1 && $3 == ws_pid { ws_sum += $4; ws_count++; if ($4 > ws_max) ws_max = $4 }
    END {
      printf "app_avg=%.2f app_max=%.2f windowserver_avg=%.2f windowserver_max=%.2f samples=%d\n",
        app_sum/app_count, app_max, ws_sum/ws_count, ws_max, app_count
    }
  ' "${samples}" | tee "${RESULT_DIR}/${name}.summary"
}

trap stop_development_app EXIT

case "${CORPTIE_SESSION_PERF_CASES:-all}" in
  focused)
    run_case sessions_18_focused_a 18 1 1 1
    run_case sessions_18_focused_b 18 1 1 1
    ;;
  all)
    run_case sessions_3 3 1 1 1
    run_case sessions_6 6 1 1 1
    run_case sessions_12 12 1 1 1
    run_case sessions_18 18 1 1 1
    run_case sessions_18_no_halo 18 0 1 1
    run_case sessions_18_no_glass 18 1 0 1
    run_case sessions_18_no_polling 18 1 1 0
    run_case sessions_18_static 18 0 0 0
    ;;
  *)
    echo "Unknown CORPTIE_SESSION_PERF_CASES=${CORPTIE_SESSION_PERF_CASES}. Use all or focused." >&2
    exit 64
    ;;
esac

echo "Results: ${RESULT_DIR}"
