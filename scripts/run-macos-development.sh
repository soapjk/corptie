#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/macos"
export CORPTIE_ENV=development
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47322}"
swift run CorptieMac
