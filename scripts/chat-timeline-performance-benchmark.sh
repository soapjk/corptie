#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
macos_dir="$repo_root/apps/macos"
report_dir="${TMPDIR:-/private/tmp}/corptie-chat-timeline-benchmark"
report_path="$report_dir/report.txt"
binary="$macos_dir/.build/arm64-apple-macosx/release/CorptieMac"

mkdir -p "$report_dir"
swift build -c release --package-path "$macos_dir"

pkill -f "$repo_root/apps/macos/.build/.*/CorptieMac" 2>/dev/null || true
CORPTIE_ENV=development \
CORPTIE_CHAT_PERFORMANCE_FIXTURE=standard \
CORPTIE_CHAT_PERFORMANCE_STREAM=1 \
CORPTIE_CHAT_UI_BATCH_INTERVAL_MS=100 \
CORPTIE_CHAT_INITIAL_DISPLAY_WEIGHT=500 \
"$binary" >"$report_dir/app.log" 2>&1 &
benchmark_pid=$!

cleanup() {
  kill "$benchmark_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 2
{
  print "Corptie chat timeline Release benchmark"
  print "fixture: 10,000 raw items / 500 visible weight / 20 Hz input / 100 ms UI batching"
  print "streaming samples:"
  top -l 8 -s 1 -pid "$benchmark_pid" -stats pid,cpu,mem,time,command | rg 'CorptieMac|^PID'
  sleep 6
  print "idle samples:"
  top -l 3 -s 1 -pid "$benchmark_pid" -stats pid,cpu,mem,time,command | rg 'CorptieMac|^PID'
} | tee "$report_path"

print "report: $report_path"
