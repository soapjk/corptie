#!/bin/sh
set -eu

CLOUD_ROOT=${CORPTIE_CLOUD_ROOT:-/Volumes/T9/data/corptie-cloud}
CONFIG_FILE=${CORPTIE_CLOUD_CONFIG:-${CLOUD_ROOT}/shared/config/cloud.env}
NODE=${CLOUD_ROOT}/shared/runtime/node

test -x "${NODE}" || { echo "Corptie Cloud backup: managed Node runtime is unavailable" >&2; exit 69; }
test -f "${CONFIG_FILE}" || { echo "Corptie Cloud backup: configuration is unavailable" >&2; exit 69; }

exec "${NODE}" --env-file="${CONFIG_FILE}" -e '
  const { spawnSync } = require("node:child_process");
  const script = process.env.CORPTIE_CLOUD_ROOT + "/current/ops/cloudctl.sh";
  const result = spawnSync("/bin/sh", [script, "backup-and-copy"], { env: process.env, stdio: "inherit" });
  process.exit(result.status ?? 70);
'
