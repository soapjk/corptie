#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/macos"
export CORPTIE_ENV=development
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47322}"

MACOS_BUILD_TRIPLE="$(uname -m)-apple-macosx"
BIN="./.build/${MACOS_BUILD_TRIPLE}/debug/CorptieMac"
MACOS_SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
MACOS_SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"

linked_macos_sdk_version() {
  local binary="$1"
  xcrun vtool -show-build "${binary}" 2>/dev/null \
    | awk '$1 == "sdk" { print $2; exit }'
}

# 产物存在且链接当前 macOS SDK 时才直接运行。更新 Xcode/SDK 后不得
# 复用旧 SDK 产物，否则 AppKit 会保留旧版兼容外观。
LINKED_SDK_VERSION=""
if [[ -x "${BIN}" ]]; then
  LINKED_SDK_VERSION="$(linked_macos_sdk_version "${BIN}")"
fi
if [[ ! -x "${BIN}" || "${LINKED_SDK_VERSION}" != "${MACOS_SDK_VERSION}" ]]; then
  if [[ -x "${BIN}" ]]; then
    echo "Discarding macOS build cache linked against SDK ${LINKED_SDK_VERSION:-unknown}; current SDK is ${MACOS_SDK_VERSION}."
    swift package clean
  fi
  # See restart-macos-development.sh: the native backend preserves the actual
  # SDK version in LC_BUILD_VERSION with the current Xcode 27 toolchain.
  swift build --build-system native --sdk "${MACOS_SDK_PATH}"
fi

LINKED_SDK_VERSION="$(linked_macos_sdk_version "${BIN}")"
if [[ "${LINKED_SDK_VERSION}" != "${MACOS_SDK_VERSION}" ]]; then
  echo "CorptieMac linked against SDK ${LINKED_SDK_VERSION:-unknown}, expected ${MACOS_SDK_VERSION}." >&2
  exit 1
fi

exec "${BIN}"
