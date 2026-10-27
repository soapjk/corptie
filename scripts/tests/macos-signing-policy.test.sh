#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT}/scripts/macos-signing-policy.sh"
PACKAGE_SCRIPT="${ROOT}/scripts/package-macos-installer.sh"
MAKEFILE="${ROOT}/Makefile"

if CORPTIE_APP_SIGNING_IDENTITY=- CORPTIE_ALLOW_ADHOC_PACKAGE=0 \
  corptie_validate_macos_signing_config >/dev/null 2>&1; then
  echo "expected accidental ad-hoc packaging to be rejected" >&2
  exit 1
fi

CORPTIE_APP_SIGNING_IDENTITY=- CORPTIE_ALLOW_ADHOC_PACKAGE=1 \
  corptie_validate_macos_signing_config
CORPTIE_APP_SIGNING_IDENTITY="Apple Development: Example (TEAMID)" \
  corptie_validate_macos_signing_config

if corptie_validate_cloud_keychain_profile /tmp/corptie-missing-test-profile.provisionprofile TEAMID >/dev/null 2>&1; then
  echo "expected a missing Cloud keychain provisioning profile to be rejected" >&2
  exit 1
fi
grep -Fq 'CORPTIE_MACOS_PROVISIONING_PROFILE' "${PACKAGE_SCRIPT}"
grep -Fq 'embedded.provisionprofile' "${PACKAGE_SCRIPT}"
grep -Fq 'CorptieCloudDataProtectionKeychain' "${PACKAGE_SCRIPT}"
grep -Fq 'corptie_find_cloud_keychain_profile' "${PACKAGE_SCRIPT}"
grep -Fq 'Cloud credentials will use the legacy keychain' "${PACKAGE_SCRIPT}"
grep -Fq 'CORPTIE_ALLOW_ADHOC_PACKAGE="$${CORPTIE_ALLOW_ADHOC_PACKAGE:-1}"' "${MAKEFILE}"

resolved="$(CORPTIE_APP_SIGNING_IDENTITY="Apple Development: Example (TEAMID)" \
  corptie_resolve_macos_signing_identity)"
[[ "${resolved}" == "Apple Development: Example (TEAMID)" ]]

# Exercise discovery without depending on the machine's keychain. Renewed
# certificates with the same subject must resolve to an exact fingerprint.
security() { printf '%s\n' "${TEST_SIGNING_IDENTITIES}"; }
first_identity='  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Example (TEAMID)"'
second_identity='  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Development: Example (TEAMID)"'
TEST_SIGNING_IDENTITIES='     0 valid identities found'
[[ "$(CORPTIE_APP_SIGNING_IDENTITY= corptie_resolve_macos_signing_identity)" == '-' ]]
TEST_SIGNING_IDENTITIES="${first_identity}"
[[ "$(CORPTIE_APP_SIGNING_IDENTITY= corptie_resolve_macos_signing_identity)" == 'Apple Development: Example (TEAMID)' ]]
TEST_SIGNING_IDENTITIES="${first_identity}"$'\n'"${second_identity}"
[[ "$(CORPTIE_APP_SIGNING_IDENTITY= corptie_resolve_macos_signing_identity)" == 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' ]]
TEST_SIGNING_IDENTITIES="${first_identity}"$'\n''  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Development: Other (OTHERTEAM)"'
[[ "$(CORPTIE_APP_SIGNING_IDENTITY= corptie_resolve_macos_signing_identity)" == '-' ]]
[[ "$(CORPTIE_APP_SIGNING_IDENTITY=explicit-fingerprint corptie_resolve_macos_signing_identity)" == 'explicit-fingerprint' ]]
unset -f security

# A fingerprint must read the selected certificate, even with duplicate names.
certificate_dir="$(mktemp -d /tmp/corptie-signing-test-XXXXXX)"
trap 'rm -rf "${certificate_dir}"' EXIT
for team in FIRSTTEAM SECONDTEAM; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=Apple Development: Example/OU=${team}" \
    -keyout "${certificate_dir}/${team}.key" \
    -out "${certificate_dir}/${team}.pem" >/dev/null 2>&1
done
security() { cat "${certificate_dir}/FIRSTTEAM.pem" "${certificate_dir}/SECONDTEAM.pem"; }
fingerprint="$(openssl x509 -in "${certificate_dir}/SECONDTEAM.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)"
[[ "$(corptie_macos_signing_team "${fingerprint}")" == SECONDTEAM ]]
[[ "$(corptie_macos_signing_team 'Apple Development: Example')" == FIRSTTEAM ]]
if corptie_macos_signing_team '0000000000000000000000000000000000000000'; then
  echo "expected an unknown signing fingerprint to fail" >&2
  exit 1
fi
unset -f security

# Local production installation must not depend on Apple's online timestamp
# service. The package remains identity-signed with the hardened runtime.
grep -Fq 'SIGN_FLAGS+=(--options runtime --timestamp=none)' "${PACKAGE_SCRIPT}"
if grep -Eq 'SIGN_FLAGS\+=\([^)]*(^|[[:space:]])--timestamp([[:space:]]|\))' "${PACKAGE_SCRIPT}"; then
  echo "local packaging must not require the online timestamp service" >&2
  exit 1
fi

echo "macOS signing policy tests passed"
