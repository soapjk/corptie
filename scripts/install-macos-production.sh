#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Keep every production installation on the same safe path. The shared
# installer checks for unfinished sessions, stops the running app and backend,
# replaces the bundle atomically, and starts the backend from the new bundle.
exec "${ROOT}/scripts/rebuild-install-restart-production.sh" "$@"
