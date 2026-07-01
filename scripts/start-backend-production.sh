#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/backend"
export COPETS_ENV=production
export COPETS_BACKEND_PORT="${COPETS_BACKEND_PORT:-47321}"
exec npm start
