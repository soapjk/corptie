#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
macos_dir="$repo_root/apps/macos"
report_dir="${TMPDIR:-/private/tmp}/corptie-chat-timeline-soak"
report_path="$report_dir/report.csv"
binary="$macos_dir/.build/arm64-apple-macosx/release/CorptieMac"
duration_seconds="${CORPTIE_SOAK_DURATION_SECONDS:-120}"
stream_interval_ms="${CORPTIE_SOAK_STREAM_INTERVAL_MS:-50}"
allowed_tail_growth_kb="${CORPTIE_SOAK_ALLOWED_TAIL_GROWTH_KB:-16384}"
stream_steps=$((duration_seconds * 1000 / stream_interval_ms))

mkdir -p "$report_dir"
swift build -c release --package-path "$macos_dir"

pkill -f "$repo_root/apps/macos/.build/.*/CorptieMac" 2>/dev/null || true
CORPTIE_ENV=development \
CORPTIE_CHAT_PERFORMANCE_FIXTURE=standard \
CORPTIE_CHAT_PERFORMANCE_STREAM=1 \
CORPTIE_CHAT_PERFORMANCE_STREAM_STEPS="$stream_steps" \
CORPTIE_CHAT_PERFORMANCE_STREAM_INTERVAL_MS="$stream_interval_ms" \
CORPTIE_CHAT_UI_BATCH_INTERVAL_MS=100 \
CORPTIE_CHAT_INITIAL_DISPLAY_WEIGHT=500 \
"$binary" >"$report_dir/app.log" 2>&1 &
soak_pid=$!

cleanup() {
  kill "$soak_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

print "elapsed_seconds,cpu_percent,rss_kb" >"$report_path"
started_at=$SECONDS
while (( SECONDS - started_at <= duration_seconds + 10 )); do
  if ! kill -0 "$soak_pid" 2>/dev/null; then
    print "Soak process exited early."
    tail -n 80 "$report_dir/app.log" || true
    exit 1
  fi
  elapsed=$((SECONDS - started_at))
  sample="$(ps -o %cpu=,rss= -p "$soak_pid" | xargs)"
  cpu="${sample%% *}"
  rss="${sample##* }"
  print "$elapsed,$cpu,$rss" | tee -a "$report_path"
  sleep 5
done

print "report: $report_path"

tail_samples="$(tail -n 13 "$report_path" | tail -n 12)"
first_tail_rss="$(print -r -- "$tail_samples" | head -n 1 | cut -d, -f3)"
last_tail_rss="$(print -r -- "$tail_samples" | tail -n 1 | cut -d, -f3)"
tail_growth_kb=$((last_tail_rss - first_tail_rss))
print "tail RSS growth: ${tail_growth_kb} KB (allowed: ${allowed_tail_growth_kb} KB)"
if (( tail_growth_kb > allowed_tail_growth_kb )); then
  print "RSS did not reach a stable platform."
  exit 1
fi
print "RSS platform check passed."
