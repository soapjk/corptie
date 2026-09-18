#!/usr/bin/env bash

corptie_validate_macos_signing_config() {
  local identity="${CORPTIE_APP_SIGNING_IDENTITY:--}"
  if [[ "${identity}" == "-" && "${CORPTIE_ALLOW_ADHOC_PACKAGE:-0}" != "1" ]]; then
    echo "Error: refusing to package Corptie with an ad-hoc signature." >&2
    echo "Set CORPTIE_APP_SIGNING_IDENTITY to a stable Apple signing identity." >&2
    echo "For an intentional local-only artifact, explicitly set CORPTIE_ALLOW_ADHOC_PACKAGE=1." >&2
    return 64
  fi
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
