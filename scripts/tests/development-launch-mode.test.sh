#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT}/scripts/development-launch-mode.sh"
[[ "$(corptie_development_launch_mode foreground)" == foreground ]]
[[ "$(corptie_development_launch_mode background)" == background ]]
[[ "$(corptie_development_launch_mode foreground --background)" == background ]]
[[ "$(corptie_development_launch_mode foreground --background --foreground)" == foreground ]]
if corptie_development_launch_mode foreground --invalid >/dev/null 2>&1; then
  echo 'Invalid launch options must fail before rebuilding or stopping processes' >&2
  exit 1
fi
rg -Fq 'restart-macos-development.sh" --background "$@"' "${ROOT}/scripts/dev-rebuild-restart.sh"
rg -Fq 'if [[ "${DEVELOPMENT_LAUNCH_MODE}" == foreground ]]; then' "${ROOT}/scripts/restart-macos-development.sh"
rg -Fq 'CORPTIE_DEVELOPMENT_LAUNCH_MODE="${DEVELOPMENT_LAUNCH_MODE}"' "${ROOT}/scripts/restart-macos-development.sh"
rg -Fq 'corptie_development_launch_mode foreground "$@"' "${ROOT}/scripts/run-macos-development.sh"
rg -Fq 'exec scripts/run-macos-development.sh "$@"' "${ROOT}/scripts/run-development.sh"
echo 'Development launch-mode tests passed'
