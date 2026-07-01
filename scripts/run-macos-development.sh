#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/macos"
export COPETS_ENV=development
export COPETS_BACKEND_PORT="${COPETS_BACKEND_PORT:-47322}"
swift run CopetsMac
