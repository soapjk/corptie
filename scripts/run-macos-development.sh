#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../apps/macos"
export CORPTIE_ENV=development
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47322}"

BIN="./.build/debug/CorptieMac"

# 产物不存在才编译。`swift build` 每次都会触发 SwiftPM manifest 沙箱编译
# （慢，且在 CI/受限环境会 sandbox_apply 失败）；产物已存在则直接运行。
# 需要强制重新编译时用 `make restart`（restart-macos-development.sh 会先 swift build）。
if [[ ! -x "${BIN}" ]]; then
  swift build
fi

exec "${BIN}"
