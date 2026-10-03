#!/bin/sh
set -eu

CLOUD_ROOT=${CORPTIE_CLOUD_ROOT:-/Volumes/T9/data/corptie-cloud}
CONFIG_FILE=${CORPTIE_CLOUD_CONFIG:-${CLOUD_ROOT}/shared/config/cloud.env}
NODE_BINARY=${CORPTIE_CLOUD_NODE:-${CLOUD_ROOT}/shared/runtime/node}

case "${CLOUD_ROOT}" in
  /Volumes/T9/data/corptie-cloud|/private/tmp/*|/tmp/*) ;;
  *) echo "Refusing unsafe CORPTIE_CLOUD_ROOT: ${CLOUD_ROOT}" >&2; exit 64 ;;
esac

test -d /Volumes/T9 2>/dev/null || case "${CLOUD_ROOT}" in /Volumes/T9/*) exit 75 ;; esac
test -f "${CONFIG_FILE}" || { echo "Missing Cloud configuration: ${CONFIG_FILE}" >&2; exit 78; }
test -x "${NODE_BINARY}" || { echo "Node 24 binary is not executable: ${NODE_BINARY}" >&2; exit 78; }
test -f "${CLOUD_ROOT}/current/dist/src/main.js" || { echo "Cloud release is incomplete" >&2; exit 78; }

exec "${NODE_BINARY}" --env-file="${CONFIG_FILE}" "${CLOUD_ROOT}/current/dist/src/main.js"
