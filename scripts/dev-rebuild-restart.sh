#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

"${ROOT_DIR}/scripts/build-web.sh"
exec "${ROOT_DIR}/scripts/restart-macos-development.sh"
