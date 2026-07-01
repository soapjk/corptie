#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/backend"
export COPETS_ENV=development
export COPETS_BACKEND_PORT="${COPETS_BACKEND_PORT:-47322}"
exec npm start
