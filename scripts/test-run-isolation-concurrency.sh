#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
worktrees=2
runs=20
while (( $# > 0 )); do
  case "$1" in
    --worktrees) worktrees="$2"; shift 2 ;;
    --runs) runs="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$worktrees" != "2" || "$runs" != "20" ]]; then
  echo "The frozen reproducibility profile is --worktrees 2 --runs 20." >&2
  exit 2
fi
cd "$ROOT_DIR/apps/backend"
exec node --test tests/runIsolation.e2e.test.mjs tests/runIsolationPortProcess.test.mjs
