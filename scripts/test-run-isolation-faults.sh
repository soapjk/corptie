#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
for required in --kill9 --pid-reuse --foreign-process --disk-full --unmount --remount; do
  found=false
  for option in "$@"; do
    if [[ "$option" == "$required" ]]; then found=true; break; fi
  done
  if [[ "$found" != true ]]; then
    echo "Missing frozen fault profile option: $required" >&2
    exit 2
  fi
done
cd "$ROOT_DIR/apps/backend"
exec node --test tests/runIsolationDataRoot.test.mjs tests/runIsolationStateMachine.test.mjs tests/runIsolationPortProcess.test.mjs tests/runIsolationJanitor.test.mjs
