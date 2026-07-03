#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/backend"
export CORPTIE_ENV=production
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47321}"
exec npm start
