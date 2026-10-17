#!/usr/bin/env bash
set -euo pipefail

build_directory="$1"
resources_directory="$2"
shift 2

# Validate before copying: missing dependency fonts must fail packaging, not
# crash the installed application on its first rendered equation.
for bundle_name in "$@"; do
  if [[ ! -d "${build_directory}/${bundle_name}" ]]; then
    echo "Required SwiftPM resource bundle not found: ${bundle_name}" >&2
    exit 1
  fi
done
mkdir -p "${resources_directory}"
shopt -s nullglob
for resource_bundle in "${build_directory}"/*.bundle; do
  [[ -d "${resource_bundle}" ]] || continue
  cp -R "${resource_bundle}" "${resources_directory}/"
done
