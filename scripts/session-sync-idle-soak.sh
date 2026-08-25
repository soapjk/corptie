#!/usr/bin/env bash
set -euo pipefail

backend_port="${CORPTIE_DEVELOPMENT_BACKEND_PORT:-47322}"
backend_url="${CORPTIE_BACKEND_URL:-http://127.0.0.1:${backend_port}}"
duration_seconds="${CORPTIE_IDLE_SOAK_SECONDS:-20}"
sample_interval_seconds="${CORPTIE_IDLE_SAMPLE_INTERVAL_SECONDS:-1}"
maximum_cpu_percent="${CORPTIE_IDLE_MAXIMUM_CPU_PERCENT:-5}"
maximum_query_rate="${CORPTIE_IDLE_MAXIMUM_QUERY_RATE:-12}"
maximum_session_query_rate="${CORPTIE_IDLE_MAXIMUM_SESSION_QUERY_RATE:-2}"
report_dir="${CORPTIE_IDLE_REPORT_DIR:-/private/tmp/corptie-session-sync-idle-soak}"

mkdir -p "${report_dir}"
before_queries="${report_dir}/queries-before.json"
after_queries="${report_dir}/queries-after.json"
before_state="${report_dir}/state-before.json"
after_state="${report_dir}/state-after.json"
cpu_samples="${report_dir}/cpu-samples.txt"
report="${report_dir}/report.json"

curl -fsS --max-time 2 "${backend_url}/health" >/dev/null
backend_pid="$(lsof -tiTCP:"${backend_port}" -sTCP:LISTEN | head -1)"
if [[ -z "${backend_pid}" ]]; then
  echo "Development backend is not listening on ${backend_port}." >&2
  exit 1
fi

curl -fsS "${backend_url}/diagnostics/sqlite-queries?limit=1000" >"${before_queries}"
curl -fsS "${backend_url}/state/diagnostics" >"${before_state}"
: >"${cpu_samples}"

started_at="${SECONDS}"
while (( SECONDS - started_at < duration_seconds )); do
  ps -o %cpu= -p "${backend_pid}" | xargs >>"${cpu_samples}"
  sleep "${sample_interval_seconds}"
done

curl -fsS "${backend_url}/diagnostics/sqlite-queries?limit=1000" >"${after_queries}"
curl -fsS "${backend_url}/state/diagnostics" >"${after_state}"

BEFORE_QUERIES="${before_queries}" AFTER_QUERIES="${after_queries}" \
BEFORE_STATE="${before_state}" AFTER_STATE="${after_state}" \
CPU_SAMPLES="${cpu_samples}" REPORT_PATH="${report}" \
DURATION_SECONDS="${duration_seconds}" MAXIMUM_CPU_PERCENT="${maximum_cpu_percent}" \
MAXIMUM_QUERY_RATE="${maximum_query_rate}" MAXIMUM_SESSION_QUERY_RATE="${maximum_session_query_rate}" \
BACKEND_PID="${backend_pid}" node <<'NODE'
const fs = require("node:fs");
const readJSON = (name) => JSON.parse(fs.readFileSync(process.env[name], "utf8"));
const before = readJSON("BEFORE_QUERIES");
const after = readJSON("AFTER_QUERIES");
const beforeState = readJSON("BEFORE_STATE");
const afterState = readJSON("AFTER_STATE");
const samples = fs.readFileSync(process.env.CPU_SAMPLES, "utf8")
  .trim().split(/\s+/).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
const key = (query) => `${query.operation}\0${query.fingerprint}\0${query.source}`;
const callsBefore = new Map(before.queries.map((query) => [key(query), query.calls]));
const deltas = after.queries.map((query) => ({
  ...query,
  delta: Math.max(0, query.calls - (callsBefore.get(key(query)) ?? 0))
})).filter((query) => query.delta > 0);
const totalQueryDelta = deltas.reduce((total, query) => total + query.delta, 0);
const timelineWriteDelta = deltas
  .filter((query) => query.operation === "run"
    && /(?:insert|update|delete).*(?:session_items|session_timeline)/.test(query.normalizedSql))
  .reduce((total, query) => total + query.delta, 0);
const sessionFamilyQueryDelta = deltas
  .filter((query) => /(?:sessions|session_bindings|session_items|session_timeline|worktrees)/.test(query.normalizedSql))
  .reduce((total, query) => total + query.delta, 0);
const durationSeconds = Math.max(1, Number(process.env.DURATION_SECONDS));
const percentile = (fraction) => samples.length === 0
  ? 0
  : samples[Math.max(0, Math.ceil(samples.length * fraction) - 1)];
const result = {
  durationSeconds: Number(process.env.DURATION_SECONDS),
  backendPid: Number(process.env.BACKEND_PID || 0),
  cpuPercent: {
    samples: samples.length,
    average: samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95: percentile(0.95),
    maximum: samples.at(-1) ?? 0
  },
  sqlite: {
    totalQueryDelta,
    sessionFamilyQueryDelta,
    totalQueriesPerSecond: totalQueryDelta / durationSeconds,
    sessionFamilyQueriesPerSecond: sessionFamilyQueryDelta / durationSeconds,
    timelineWriteDelta,
    changedQueries: deltas.map(({ normalizedSql, source, operation, delta }) => ({ operation, source, delta, normalizedSql }))
  },
  stateRevision: {
    before: beforeState.revision,
    after: afterState.revision,
    delta: afterState.revision - beforeState.revision
  }
};
fs.writeFileSync(process.env.REPORT_PATH, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (result.cpuPercent.p95 >= Number(process.env.MAXIMUM_CPU_PERCENT)
  || result.sqlite.totalQueriesPerSecond > Number(process.env.MAXIMUM_QUERY_RATE)
  || result.sqlite.sessionFamilyQueriesPerSecond > Number(process.env.MAXIMUM_SESSION_QUERY_RATE)
  || timelineWriteDelta !== 0
  || result.stateRevision.delta !== 0) process.exitCode = 1;
NODE

echo "Idle soak report: ${report}"
