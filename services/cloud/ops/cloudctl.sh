#!/bin/sh
set -eu

CLOUD_ROOT=${CORPTIE_CLOUD_ROOT:-/Volumes/T9/data/corptie-cloud}
CONFIG_FILE=${CORPTIE_CLOUD_CONFIG:-${CLOUD_ROOT}/shared/config/cloud.env}
SERVICE_LABEL=${CORPTIE_CLOUD_SERVICE_LABEL:-system/com.corptie.cloud}
SKIP_SERVICE=${CORPTIE_CLOUD_SKIP_SERVICE:-0}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd)
DB_PATH=${CORPTIE_CLOUD_DATABASE_PATH:-${CLOUD_ROOT}/shared/data/cloud.sqlite}
SECONDARY_BACKUP_DIR=${CORPTIE_CLOUD_SECONDARY_BACKUP_DIR:-}
BACKUP_KEY_FILE=${CORPTIE_CLOUD_BACKUP_KEY_FILE:-}
MANAGED_NODE=${CLOUD_ROOT}/shared/runtime/node
MANAGED_NPM_CLI=${CLOUD_ROOT}/shared/runtime/npm/lib/node_modules/npm/bin/npm-cli.js

die() { echo "cloudctl: $*" >&2; exit 64; }
safe_root() {
  printf '%s' "${CLOUD_ROOT}" | grep -Eq '^/[A-Za-z0-9._/-]+$' || die "Cloud root contains unsafe characters"
  case "${CLOUD_ROOT}" in
    /Volumes/T9/data/corptie-cloud|/private/tmp/*|/tmp/*) ;;
    *) die "refusing unsafe CORPTIE_CLOUD_ROOT: ${CLOUD_ROOT}" ;;
  esac
  test "${DB_PATH}" = "${CLOUD_ROOT}/shared/data/cloud.sqlite" || die "database path must stay inside the managed Cloud data directory"
}
require_revision() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{7,40}$' || die "revision must be a hexadecimal Git object id"; }
require_name() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._-]+$' || die "unsafe file name"; }
managed_npm() {
  test -x "${MANAGED_NODE}" || die "managed Node runtime is unavailable"
  test -f "${MANAGED_NPM_CLI}" || die "managed npm runtime is unavailable"
  "${MANAGED_NODE}" "${MANAGED_NPM_CLI}" "$@"
}
prepare_layout() {
  safe_root
  umask 077
  mkdir -p "${CLOUD_ROOT}/releases" "${CLOUD_ROOT}/shared/config" "${CLOUD_ROOT}/shared/data" \
    "${CLOUD_ROOT}/shared/backups" "${CLOUD_ROOT}/shared/logs" "${CLOUD_ROOT}/shared/run"
}
integrity() {
  test -f "$1" || die "database does not exist: $1"
  result=$(sqlite3 "$1" 'PRAGMA quick_check;' 2>/dev/null) || die "SQLite integrity check failed"
  test "${result}" = "ok" || die "SQLite integrity check returned: ${result}"
}
restart_service() {
  test "${SKIP_SERVICE}" = "1" && return 0
  launchctl kickstart -k "${SERVICE_LABEL}"
}
stop_service() {
  test "${SKIP_SERVICE}" = "1" && return 0
  launchctl kill SIGTERM "${SERVICE_LABEL}" 2>/dev/null || true
  count=0
  while launchctl print "${SERVICE_LABEL}" 2>/dev/null | grep -q 'state = running'; do
    count=$((count + 1)); test "${count}" -lt 30 || die "Cloud service did not stop"
    sleep 1
  done
}
backup_database() {
  prepare_layout
  test -f "${DB_PATH}" || die "database does not exist: ${DB_PATH}"
  stamp=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
  require_name "${stamp}"
  target="${CLOUD_ROOT}/shared/backups/cloud-${stamp}.sqlite"
  test ! -e "${target}" || die "backup already exists: ${target}"
  sqlite3 "${DB_PATH}" ".backup '${target}'"
  chmod 600 "${target}"
  integrity "${target}"
  rm -f "${target}-wal" "${target}-shm"
  shasum -a 256 "${target}" > "${target}.sha256"
  chmod 600 "${target}.sha256"
  echo "${target}"
}
copy_secondary() {
  source_file=$1
  test -n "${SECONDARY_BACKUP_DIR}" || die "secondary backup directory is not configured"
  test -n "${BACKUP_KEY_FILE}" || die "backup key file is not configured"
  printf '%s' "${SECONDARY_BACKUP_DIR}" | grep -Eq '^/[A-Za-z0-9._/-]+$' || die "secondary backup directory contains unsafe characters"
  case "${SECONDARY_BACKUP_DIR}" in /*) ;; *) die "secondary backup directory must be absolute" ;; esac
  case "${BACKUP_KEY_FILE}" in /*) ;; *) die "backup key file must be absolute" ;; esac
  case "${SECONDARY_BACKUP_DIR}" in "${CLOUD_ROOT}"|"${CLOUD_ROOT}/"*) die "secondary backup must be outside Cloud root" ;; esac
  test -d "${SECONDARY_BACKUP_DIR}" || die "secondary backup directory must already exist"
  test -f "${BACKUP_KEY_FILE}" || die "backup key file does not exist"
  test "$(stat -f '%Lp' "${BACKUP_KEY_FILE}")" = "600" || die "backup key file permissions must be 0600"
  if test "${CORPTIE_CLOUD_ALLOW_SAME_DEVICE_BACKUP:-0}" != "1"; then
    test "$(stat -f '%d' "${CLOUD_ROOT}")" != "$(stat -f '%d' "${SECONDARY_BACKUP_DIR}")" || \
      die "secondary backup directory must be on a different physical volume"
  fi
  case "${source_file}" in "${CLOUD_ROOT}/shared/backups/"*.sqlite) ;; *) die "source must be a managed backup" ;; esac
  integrity "${source_file}"
  test -f "${source_file}.sha256" || die "backup checksum is missing"
  (cd "$(dirname "${source_file}")" && shasum -a 256 -c "$(basename "${source_file}.sha256")") >/dev/null || die "backup checksum mismatch"
  name=$(basename "${source_file}")
  target="${SECONDARY_BACKUP_DIR}/${name}.enc"
  test ! -e "${target}" || die "encrypted secondary backup already exists"
  temporary="${target}.$$"
  trap 'rm -f "${temporary}"' EXIT HUP INT TERM
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -md sha256 \
    -pass "file:${BACKUP_KEY_FILE}" -in "${source_file}" -out "${temporary}"
  chmod 600 "${temporary}"
  mv "${temporary}" "${target}"
  trap - EXIT HUP INT TERM
  shasum -a 256 "${target}" > "${target}.sha256"
  chmod 600 "${target}.sha256"
  echo "${target}"
}
prune_backups() {
  prefix=$1; keep=$2
  find "${CLOUD_ROOT}/shared/backups" -maxdepth 1 -type f -name "cloud-${prefix}-*.sqlite" -print \
    | sort -r | awk -v keep="${keep}" 'NR > keep' | while IFS= read -r file; do
      rm -f "${file}" "${file}.sha256"
    done
  find "${SECONDARY_BACKUP_DIR}" -maxdepth 1 -type f -name "cloud-${prefix}-*.sqlite.enc" -print \
    | sort -r | awk -v keep="${keep}" 'NR > keep' | while IFS= read -r file; do
      rm -f "${file}" "${file}.sha256"
    done
}
scheduled_backup() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  daily=$(backup_database "daily-${stamp}")
  copy_secondary "${daily}" >/dev/null
  if test "$(date -u +%u)" = "7"; then
    weekly=$(backup_database "weekly-${stamp}")
    copy_secondary "${weekly}" >/dev/null
  fi
  prune_backups daily 14
  prune_backups weekly 4
  echo "${daily}"
}
switch_release() {
  target=$1
  test -d "${target}" || die "release does not exist: ${target}"
  test -f "${target}/dist/src/main.js" || die "release is incomplete: ${target}"
  if test -f "${DB_PATH}"; then
    db_schema=$(sqlite3 "${DB_PATH}" 'SELECT COALESCE(MAX(version),0) FROM cloud_schema_migrations;' 2>/dev/null || echo invalid)
    release_schema=$(tr -d '[:space:]' < "${target}/schema-version" 2>/dev/null || echo invalid)
    test "${db_schema}" = "${release_schema}" || die "database schema ${db_schema} is incompatible with release schema ${release_schema}"
  fi
  link="${CLOUD_ROOT}/current.next.$$"
  ln -s "${target}" "${link}"
  mv -h "${link}" "${CLOUD_ROOT}/current"
  restart_service
}

command=${1:-}
case "${command}" in
  validate-config)
    safe_root
    test -f "${CONFIG_FILE}" || die "missing config: ${CONFIG_FILE}"
    mode=$(stat -f '%Lp' "${CONFIG_FILE}")
    test "${mode}" = "600" || die "config permissions must be 0600, found ${mode}"
    (
      cd "${PROJECT_ROOT}/services/cloud"
      "$(command -v node)" --env-file="${CONFIG_FILE}" --input-type=module -e \
        "import { loadCloudConfig } from './dist/src/config.js'; loadCloudConfig(process.env)"
    ) >/dev/null || die "Cloud configuration failed schema validation"
    grep -q '^CORPTIE_CLOUD_PUBLIC_BASE_URL=https://corptie\.llmay\.cn$' "${CONFIG_FILE}" || die "unexpected public base URL"
    grep -q '^CORPTIE_CLOUD_HOST=127\.0\.0\.1$' "${CONFIG_FILE}" || die "Cloud must bind to loopback"
    grep -q '^CORPTIE_CLOUD_DATABASE_PATH=/Volumes/T9/data/corptie-cloud/shared/data/cloud\.sqlite$' "${CONFIG_FILE}" || \
      case "${CLOUD_ROOT}" in /private/tmp/*|/tmp/*) ;; *) die "unexpected database path" ;; esac
    echo "configuration shape is valid"
    ;;
  validate-templates)
    plutil -lint "${SCRIPT_DIR}/com.corptie.cloud.plist.example" >/dev/null
    plutil -lint "${SCRIPT_DIR}/com.corptie.cloud.backup.plist.example" >/dev/null
    grep -q '^corptie\.llmay\.cn {' "${SCRIPT_DIR}/Caddyfile.example" || die "Caddy host is missing"
    grep -q '127\.0\.0\.1:19081' "${SCRIPT_DIR}/Caddyfile.example" || die "Caddy target is missing"
    grep -q '^target_addr=127\.0\.0\.1:4310$' "${SCRIPT_DIR}/npc-corptie.conf.example" || die "NPC target is missing"
    grep -q '^server_port=19081$' "${SCRIPT_DIR}/npc-corptie.conf.example" || die "NPC port is missing"
    echo "deployment templates are valid"
    ;;
  install-runtime)
    prepare_layout
    source_node=${2:-}
    test -n "${source_node}" || die "usage: cloudctl.sh install-runtime <node-24-binary>"
    test -x "${source_node}" || die "Node source is not executable"
    major=$("${source_node}" -p "Number(process.versions.node.split('.')[0])") || die "Node source cannot run"
    test "${major}" = "24" || die "Cloud runtime must be Node 24"
    source_root=$(CDPATH= cd -- "$(dirname -- "${source_node}")/.." && pwd)
    bundled_npm="${source_root}/lib/node_modules/npm"
    test -f "${bundled_npm}/bin/npm-cli.js" || die "Node source must include its bundled npm runtime"
    mkdir -p "${CLOUD_ROOT}/shared/runtime"
    temporary="${CLOUD_ROOT}/shared/runtime/node.$$"
    npm_temporary=$(mktemp -d "${CLOUD_ROOT}/shared/runtime/npm.XXXXXX")
    trap 'rm -f "${temporary}"; rm -rf "${npm_temporary}"' EXIT HUP INT TERM
    cp "${source_node}" "${temporary}"
    chmod 700 "${temporary}"
    test "$("${temporary}" -p "Number(process.versions.node.split('.')[0])")" = "24" || die "copied Node runtime failed verification"
    mkdir -p "${npm_temporary}/lib/node_modules"
    cp -R "${bundled_npm}" "${npm_temporary}/lib/node_modules/npm"
    mv "${temporary}" "${CLOUD_ROOT}/shared/runtime/node"
    rm -rf "${CLOUD_ROOT}/shared/runtime/npm"
    mv "${npm_temporary}" "${CLOUD_ROOT}/shared/runtime/npm"
    trap - EXIT HUP INT TERM
    managed_npm --version >/dev/null
    "${MANAGED_NODE}" -p "'installed Node ' + process.versions.node + ' with npm'"
    ;;
  backup)
    backup_database "${2:-}"
    ;;
  backup-and-copy)
    if test -n "${2:-}"; then
      backup=$(backup_database "$2")
      copy_secondary "${backup}"
    else
      scheduled_backup
    fi
    ;;
  restore)
    prepare_layout
    source_file=${2:-}; confirmation=${3:-}
    test -n "${source_file}" || die "usage: cloudctl.sh restore <backup.sqlite> --confirm-data-loss"
    test "${confirmation}" = "--confirm-data-loss" || die "restore requires --confirm-data-loss"
    case "${source_file}" in "${CLOUD_ROOT}/shared/backups/"*.sqlite) ;; *) die "backup must be inside the managed backup directory" ;; esac
    integrity "${source_file}"
    test -f "${source_file}.sha256" || die "backup checksum is missing"
    (cd "$(dirname "${source_file}")" && shasum -a 256 -c "$(basename "${source_file}.sha256")") >/dev/null || die "backup checksum mismatch"
    stop_service
    if test -f "${DB_PATH}"; then backup_database "pre-restore-$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null; fi
    temporary="${DB_PATH}.restore.$$"
    trap 'rm -f "${temporary}"' EXIT HUP INT TERM
    cp -p "${source_file}" "${temporary}"
    integrity "${temporary}"
    mv "${temporary}" "${DB_PATH}"
    trap - EXIT HUP INT TERM
    rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
    integrity "${DB_PATH}"
    restart_service
    echo "restored ${source_file}"
    ;;
  deploy)
    prepare_layout
    revision=${2:-}; require_revision "${revision}"
    resolved=$(git -C "${PROJECT_ROOT}" rev-parse --verify "${revision}^{commit}") || die "unknown revision"
    release="${CLOUD_ROOT}/releases/${resolved}"
    test ! -e "${release}" || die "release already exists: ${resolved}"
    staging=$(mktemp -d "${CLOUD_ROOT}/shared/run/deploy.XXXXXX")
    trap 'rm -rf "${staging}"' EXIT HUP INT TERM
    git -C "${PROJECT_ROOT}" archive "${resolved}" services/cloud | tar -x -C "${staging}"
    (cd "${staging}/services/cloud" && managed_npm ci && managed_npm run build && managed_npm test && managed_npm prune --omit=dev)
    printf '2\n' > "${staging}/services/cloud/schema-version"
    printf '%s\n' "${resolved}" > "${staging}/services/cloud/revision"
    chmod -R go-w "${staging}/services/cloud"
    mv "${staging}/services/cloud" "${release}"
    trap - EXIT HUP INT TERM
    rm -rf "${staging}"
    if test -f "${DB_PATH}"; then backup_database "pre-deploy-${resolved}" >/dev/null; fi
    switch_release "${release}"
    echo "deployed ${resolved}"
    ;;
  rollback)
    prepare_layout
    revision=${2:-}; require_revision "${revision}"
    target="${CLOUD_ROOT}/releases/${revision}"
    test -d "${target}" || {
      matches=$(find "${CLOUD_ROOT}/releases" -maxdepth 1 -type d -name "${revision}*" | wc -l | tr -d ' ')
      test "${matches}" = "1" || die "release not found or revision is ambiguous"
      target=$(find "${CLOUD_ROOT}/releases" -maxdepth 1 -type d -name "${revision}*" -print -quit)
    }
    if test -f "${DB_PATH}"; then backup_database "pre-rollback-$(basename "${target}")" >/dev/null; fi
    switch_release "${target}"
    echo "rolled back to $(basename "${target}")"
    ;;
  status)
    safe_root
    current=$(readlink "${CLOUD_ROOT}/current" 2>/dev/null || echo unavailable)
    ready_file=$(mktemp "${TMPDIR:-/tmp}/corptie-cloud-ready.XXXXXX")
    if curl --fail --silent --max-time 3 http://127.0.0.1:4310/readyz > "${ready_file}"; then ready=$(cat "${ready_file}"); else ready=unavailable; fi
    rm -f "${ready_file}"
    if test "${SKIP_SERVICE}" = "1"; then service=skipped
    elif launchctl print "${SERVICE_LABEL}" 2>/dev/null | grep -q 'state = running'; then service=running
    else service=stopped; fi
    printf 'release=%s\nservice=%s\nready=%s\n' "${current}" "${service}" "${ready}"
    ;;
  *)
    die "usage: cloudctl.sh {validate-config|validate-templates|install-runtime <node-24-binary>|backup [name]|backup-and-copy [name]|restore <backup> --confirm-data-loss|deploy <revision>|rollback <revision>|status}"
    ;;
esac
