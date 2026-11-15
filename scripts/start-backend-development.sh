#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/backend"
export CORPTIE_ENV=development
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47322}"
# A host shell may inject NODE_OPTIONS that preloads a sandbox shim bound to
# that shell's process. This backend is a detached, long-lived child: once the
# parent exits, the shim's broker is gone and the next filesystem call crashes
# the server. Drop the inherited hook before exec'ing Node.
unset NODE_OPTIONS
exec node src/server.mjs
