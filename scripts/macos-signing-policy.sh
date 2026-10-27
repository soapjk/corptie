#!/usr/bin/env bash

corptie_validate_macos_signing_config() {
  local identity="${1:-${CORPTIE_APP_SIGNING_IDENTITY:--}}"
  if [[ "${identity}" == "-" && "${CORPTIE_ALLOW_ADHOC_PACKAGE:-0}" != "1" ]]; then
    echo "Error: refusing to package Corptie with an ad-hoc signature." >&2
    echo "Set CORPTIE_APP_SIGNING_IDENTITY to a stable Apple signing identity." >&2
    echo "For an intentional local-only artifact, explicitly set CORPTIE_ALLOW_ADHOC_PACKAGE=1." >&2
    return 64
  fi
}

corptie_resolve_macos_signing_identity() {
  if [[ -n "${CORPTIE_APP_SIGNING_IDENTITY:-}" ]]; then
    printf '%s\n' "${CORPTIE_APP_SIGNING_IDENTITY}"
    return 0
  fi

  local identities=() hashes=() hash identity
  while IFS=$'\t' read -r hash identity; do
    if [[ -n "${hash}" && -n "${identity}" ]]; then
      hashes+=("${hash}")
      identities+=("${identity}")
    fi
  done < <(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n $'s/^[[:space:]]*[0-9][0-9]*) \\([A-F0-9]*\\) "\\(Apple Development:.*\\)"$/\\1\t\\2/p')

  if [[ ${#identities[@]} -eq 1 ]]; then
    printf '%s\n' "${identities[0]}"
    return 0
  fi
  if [[ ${#identities[@]} -gt 1 ]]; then
    # Certificate renewal can leave multiple valid certificates for the same
    # developer. Use an exact fingerprint to avoid both ambiguous name lookup
    # and an ad-hoc fallback that changes the app's privacy identity.
    for identity in "${identities[@]}"; do
      if [[ "${identity}" != "${identities[0]}" ]]; then
        printf '%s\n' '-'
        return 0
      fi
    done
    printf '%s\n' "${hashes[0]}"
    return 0
  fi
  printf '%s\n' '-'
}

corptie_macos_signing_team() {
  local identity="$1"
  # find-certificate -c accepts a name, not the SHA-1 fingerprint returned
  # when renewed certificates share a name. Match the exact public certificate.
  security find-certificate -a -p | node -e '
    const { X509Certificate } = require("node:crypto");
    const identity = process.argv[1];
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      for (const pem of input.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []) {
        const certificate = new X509Certificate(pem);
        const subject = certificate.toLegacyObject().subject;
        const matches = /^[a-f0-9]{40}$/i.test(identity)
          ? certificate.fingerprint.replaceAll(":", "").toUpperCase() === identity.toUpperCase()
          : subject.CN === identity;
        if (matches && typeof subject.OU === "string" && subject.OU) {
          process.stdout.write(subject.OU);
          return;
        }
      }
      process.exitCode = 68;
    });
  ' "${identity}"
}

corptie_verify_signed_bundle_identity() {
  local app_path="$1"
  local helper_path="${app_path}/Contents/Helpers/node"
  local app_team helper_team
  app_team="$(codesign -dv --verbose=4 "${app_path}" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  helper_team="$(codesign -dv --verbose=4 "${helper_path}" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  if [[ -z "${app_team}" || "${app_team}" == "not set" ]]; then
    echo "Error: packaged app has no stable TeamIdentifier." >&2
    return 65
  fi
  if [[ "${app_team}" != "${helper_team}" ]]; then
    echo "Error: app and bundled backend helper have different TeamIdentifier values." >&2
    return 66
  fi
}

corptie_validate_cloud_keychain_profile() {
  local profile_path="$1" expected_team="$2"
  local expected_app_id="${expected_team}.com.corptie.mac"
  if [[ ! -f "${profile_path}" ]]; then
    echo "Error: a macOS provisioning profile is required for the Cloud data-protection keychain." >&2
    return 67
  fi
  local decoded_profile profile_team profile_app_id groups
  decoded_profile="$(mktemp /tmp/corptie-macos-profile-XXXXXX)"
  if ! security cms -D -i "${profile_path}" -o "${decoded_profile}" >/dev/null 2>&1; then
    rm -f "${decoded_profile}"
    echo "Error: unable to decode the macOS provisioning profile." >&2
    return 68
  fi
  profile_team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "${decoded_profile}" 2>/dev/null || true)"
  profile_app_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "${decoded_profile}" 2>/dev/null || true)"
  if [[ -z "${profile_app_id}" ]]; then
    profile_app_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "${decoded_profile}" 2>/dev/null || true)"
  fi
  groups="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:keychain-access-groups' "${decoded_profile}" 2>/dev/null || true)"
  rm -f "${decoded_profile}"
  if [[ "${profile_team}" != "${expected_team}" ]] ||
     [[ "${profile_app_id}" != "${expected_app_id}" && "${profile_app_id}" != "${expected_team}.*" ]] ||
     { [[ "${groups}" != *"${expected_app_id}"* ]] && [[ "${groups}" != *"${expected_team}.*"* ]]; }; then
    echo "Error: the provisioning profile does not authorize ${expected_app_id} and its keychain group." >&2
    return 69
  fi
}

corptie_find_cloud_keychain_profile() {
  local expected_team="$1" directory profile
  local profile_directories=(
    "${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles"
    "${HOME}/Library/MobileDevice/Provisioning Profiles"
  )

  for directory in "${profile_directories[@]}"; do
    [[ -d "${directory}" ]] || continue
    while IFS= read -r -d '' profile; do
      if corptie_validate_cloud_keychain_profile "${profile}" "${expected_team}" >/dev/null 2>&1; then
        printf '%s\n' "${profile}"
        return 0
      fi
    done < <(find "${directory}" -maxdepth 1 -type f \
      \( -name '*.provisionprofile' -o -name '*.mobileprovision' \) -print0)
  done
  return 1
}
