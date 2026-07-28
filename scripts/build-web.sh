#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

npm --prefix "${ROOT_DIR}/apps/web" run build
