#!/usr/bin/env bash
set -euo pipefail

# Official, relocatable Node distribution; never copy a Homebrew executable.
# Update the version and independently verified upstream SHA-256 together.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="24.20.0"
SHA256="40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8"
NAME="node-v${VERSION}-darwin-arm64"
CACHE="${ROOT}/.build/bundled-node"
ARCHIVE="${CACHE}/${NAME}.tar.gz"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "The macOS installer currently targets Apple Silicon and must be built on arm64 macOS." >&2
  exit 1
fi
mkdir -p "${CACHE}"
if [[ ! -f "${ARCHIVE}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://nodejs.org/dist/v${VERSION}/${NAME}.tar.gz" -o "${ARCHIVE}.partial"
  mv "${ARCHIVE}.partial" "${ARCHIVE}"
fi
printf '%s  %s\n' "${SHA256}" "${ARCHIVE}" | shasum -a 256 -c - >&2
# Re-extract the verified archive rather than trusting a modified cache binary.
rm -rf "${CACHE:?}/${NAME}"
tar -xzf "${ARCHIVE}" -C "${CACHE}"
"${CACHE}/${NAME}/bin/node" -e 'const db = new (require("node:sqlite").DatabaseSync)(":memory:"); db.exec("SELECT 1"); db.close()'
printf '%s\n' "${CACHE}/${NAME}"
