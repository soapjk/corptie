#!/usr/bin/env bash
set -euo pipefail

LOG_PATH="${1:?An external development log path is required.}"
shift
if [[ "${LOG_PATH}" != /Volumes/* ]]; then
  echo "Development process logs must use an explicitly configured external volume path." >&2
  exit 1
fi
mkdir -p "$(dirname "${LOG_PATH}")"
exec "$@" >>"${LOG_PATH}" 2>&1
