#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT}/scripts/macos-signing-policy.sh"
PACKAGE_SCRIPT="${ROOT}/scripts/package-macos-installer.sh"

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

# Local production installation must not depend on Apple's online timestamp
# service. The package remains identity-signed with the hardened runtime.
grep -Fq 'SIGN_FLAGS+=(--options runtime --timestamp=none)' "${PACKAGE_SCRIPT}"
if grep -Eq 'SIGN_FLAGS\+=\([^)]*(^|[[:space:]])--timestamp([[:space:]]|\))' "${PACKAGE_SCRIPT}"; then
  echo "local packaging must not require the online timestamp service" >&2
  exit 1
fi

echo "macOS signing policy tests passed"
