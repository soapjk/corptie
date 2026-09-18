#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT}/scripts/macos-signing-policy.sh"

if CORPTIE_APP_SIGNING_IDENTITY=- CORPTIE_ALLOW_ADHOC_PACKAGE=0 \
  corptie_validate_macos_signing_config >/dev/null 2>&1; then
  echo "expected accidental ad-hoc packaging to be rejected" >&2
  exit 1
fi

CORPTIE_APP_SIGNING_IDENTITY=- CORPTIE_ALLOW_ADHOC_PACKAGE=1 \
  corptie_validate_macos_signing_config
CORPTIE_APP_SIGNING_IDENTITY="Apple Development: Example (TEAMID)" \
  corptie_validate_macos_signing_config

resolved="$(CORPTIE_APP_SIGNING_IDENTITY="Apple Development: Example (TEAMID)" \
  corptie_resolve_macos_signing_identity)"
[[ "${resolved}" == "Apple Development: Example (TEAMID)" ]]

echo "macOS signing policy tests passed"
