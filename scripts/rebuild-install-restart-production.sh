#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="/Applications/Corptie.app"
APP_EXECUTABLE="${APP_PATH}/Contents/MacOS/Corptie"
BACKEND_PORT="${CORPTIE_PRODUCTION_PORT:-47321}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
HEALTH_TIMEOUT_SECONDS="${CORPTIE_PRODUCTION_HEALTH_TIMEOUT_SECONDS:-180}"
LAUNCH_AGENT_LABEL="com.corptie.backend"
LAUNCH_AGENT_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
BACKEND_LOG_DIR="${HOME}/Library/Logs/Corptie"
BACKEND_STDOUT_LOG="${BACKEND_LOG_DIR}/backend.out.log"
BACKEND_STDERR_LOG="${BACKEND_LOG_DIR}/backend.err.log"
CHECK_ONLY=false
RESET_PRODUCTION_DATABASE=false
MOUNT_POINT=""
STAGED_APP=""
OLD_APP=""
BUILD_LOG=""
STOPPED_PRODUCTION=false
FINISHED=false

usage() {
  cat <<'USAGE'
Usage: scripts/rebuild-install-restart-production.sh [--check-only] [--reset-production-database]

Build the current checkout as a production installer, safely stop an idle
production app, install it into /Applications, and open the new version.

Options:
  --check-only  Only report whether production has unfinished sessions.
  --reset-production-database
                Permanently delete the production SQLite database before
                installing. No backup is created. Settings and artifacts are
                left in place.
USAGE
}

for argument in "$@"; do
  case "${argument}" in
    --check-only) CHECK_ONLY=true ;;
    --reset-production-database) RESET_PRODUCTION_DATABASE=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: ${argument}" >&2; usage >&2; exit 64 ;;
  esac
done

if [[ "${CHECK_ONLY}" == true && "${RESET_PRODUCTION_DATABASE}" == true ]]; then
  echo "--check-only and --reset-production-database cannot be used together." >&2
  exit 64
fi

if ! [[ "${HEALTH_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "CORPTIE_PRODUCTION_HEALTH_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 64
fi

find_node() {
  local candidate
  # This script may be called while the user's interactive shell setup is
  # broken, so resolve known Node installations without starting that shell.
  for candidate in \
    "${HOME}"/.nvm/versions/node/*/bin/node \
    "${HOME}"/.fnm/node-versions/*/installation/bin/node \
    "${HOME}/.asdf/shims/node" \
    "${HOME}/.local/share/mise/shims/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "Node.js is required to inspect production sessions." >&2
  exit 1
fi

production_app_pids() {
  pgrep -f "^${APP_EXECUTABLE}([[:space:]]|$)" 2>/dev/null || true
}

production_is_running() {
  launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 \
    || lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN >/dev/null 2>&1 \
    || [[ -n "$(production_app_pids)" ]]
}

unfinished_sessions() {
  curl --fail --silent --show-error --max-time 5 "${BACKEND_URL}/sessions" \
    | "${NODE_BIN}" -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const payload = JSON.parse(input);
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        const unfinished = sessions.filter((session) => {
          const status = String(session.status || "").toLowerCase();
          const activity = String(session.activityStatus || "").toLowerCase();
          const rawStatus = session.external?.rawStatus ?? session.rawStatus;
          const rawType = String(
            typeof rawStatus === "object" && rawStatus ? rawStatus.type : rawStatus || ""
          ).toLowerCase();
          const activeTurnId = session.external?.activeTurnId ?? session.rawStatus?.activeTurnId;
          if (activeTurnId) return true;
          if (["active", "inprogress", "in_progress", "running"].includes(rawType)) return true;
          if (status === "running") return true;
          // Codex PTY reports an answered, waiting-for-user session as blocked/Ready.
          // Other blocked states still represent pending approval or user input.
          return status === "blocked" && !["ready", "idle"].includes(activity);
        });
        for (const session of unfinished) {
          const clean = (value) => String(value || "").replace(/[\t\r\n]+/g, " ").trim();
          process.stdout.write([
            clean(session.id),
            clean(session.title || "Untitled session"),
            clean(session.status),
            clean(session.activityStatus)
          ].join("\t") + "\n");
        }
      });
    '
}

check_production_sessions() {
  local active
  if ! active="$(unfinished_sessions)"; then
    echo "Cannot verify production sessions at ${BACKEND_URL}; production will not be stopped." >&2
    return 3
  fi
  if [[ -n "${active}" ]]; then
    echo "Production has unfinished sessions; leaving it running:" >&2
    while IFS=$'\t' read -r id title status activity; do
      printf '  - %s [%s%s] %s\n' \
        "${title}" \
        "${status}" \
        "${activity:+ / ${activity}}" \
        "${id}" >&2
    done <<<"${active}"
    return 2
  fi
  echo "Production has no unfinished sessions."
}

production_data_root() {
  local pointer_file="${HOME}/Library/Application Support/Corptie/data-root.json"
  local configured_root=""
  if [[ -f "${pointer_file}" ]]; then
    configured_root="$(${NODE_BIN} -e '
      const fs = require("node:fs");
      try {
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (typeof value.dataRoot === "string" && value.dataRoot.trim()) {
          process.stdout.write(value.dataRoot.trim());
        }
      } catch {}
    ' "${pointer_file}")"
  fi
  printf '%s\n' "${configured_root:-${HOME}/.corptie}"
}

legacy_configured_data_dir() {
  "${NODE_BIN}" -e '
    const fs = require("node:fs");
    for (const file of process.argv.slice(1)) {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof value.dataDir === "string" && value.dataDir.trim()) {
          process.stdout.write(value.dataDir.trim());
          break;
        }
      } catch {}
    }
  ' \
    "${HOME}/Library/Application Support/Corptie/config.json" \
    "${HOME}/Library/Application Support/Copets/config.json"
}

delete_sqlite_family() {
  local database_path="$1" parent
  parent="$(dirname "${database_path}")"
  if [[ "${database_path}" != /* || "${parent}" == "/" || "${parent}" == "${HOME}" ]]; then
    echo "Refusing to delete SQLite files at unsafe path: ${database_path}" >&2
    return 1
  fi
  echo "  - ${database_path}{,-wal,-shm}"
  rm -f "${database_path}" "${database_path}-wal" "${database_path}-shm"
}

reset_production_database() {
  local data_root database_dir configured_data_dir
  data_root="$(production_data_root)"
  if [[ "${data_root}" != /* || "${data_root}" == "/" || "${data_root}" == "${HOME}" ]]; then
    echo "Refusing to reset a production database under unsafe data root: ${data_root}" >&2
    return 1
  fi
  database_dir="${data_root}/database"
  configured_data_dir="$(legacy_configured_data_dir)"
  echo "Permanently deleting production SQLite database and automatic-import candidates (no backup):"
  delete_sqlite_family "${database_dir}/corptie.sqlite"
  if [[ -n "${configured_data_dir}" ]]; then
    delete_sqlite_family "${configured_data_dir}/corptie.sqlite"
    delete_sqlite_family "${configured_data_dir}/copets.sqlite"
  fi
  delete_sqlite_family "${HOME}/Library/Application Support/Corptie/corptie.sqlite"
  delete_sqlite_family "${HOME}/Library/Application Support/Corptie/copets.sqlite"
  delete_sqlite_family "${HOME}/Library/Application Support/Copets/corptie.sqlite"
  delete_sqlite_family "${HOME}/Library/Application Support/Copets/copets.sqlite"
}

stop_pids() {
  local label="$1"
  shift
  local pids=("$@") alive=() pid
  (( ${#pids[@]} > 0 )) || return 0
  echo "Stopping ${label}: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  for _ in {1..40}; do
    alive=()
    for pid in "${pids[@]}"; do
      kill -0 "${pid}" 2>/dev/null && alive+=("${pid}")
    done
    (( ${#alive[@]} == 0 )) && return 0
    sleep 0.25
  done
  echo "Force stopping ${label}: ${alive[*]}"
  kill -9 "${alive[@]}" 2>/dev/null || true
  for _ in {1..20}; do
    alive=()
    for pid in "${pids[@]}"; do
      kill -0 "${pid}" 2>/dev/null && alive+=("${pid}")
    done
    (( ${#alive[@]} == 0 )) && return 0
    sleep 0.1
  done
  echo "Unable to stop ${label}: ${alive[*]}" >&2
  return 1
}

stop_production() {
  local app_pids=() backend_pids=() pid

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && app_pids+=("${pid}")
  done < <(production_app_pids)
  if (( ${#app_pids[@]} > 0 )); then
    stop_pids "production app" "${app_pids[@]}"
  fi

  launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 \
    || launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT_PLIST}" >/dev/null 2>&1 \
    || true

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && backend_pids+=("${pid}")
  done < <(lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null || true)
  if (( ${#backend_pids[@]} > 0 )); then
    stop_pids "production backend" "${backend_pids[@]}"
  fi

  if lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Production backend port ${BACKEND_PORT} is still occupied." >&2
    return 1
  fi
  STOPPED_PRODUCTION=true
}

cleanup() {
  local status=$?
  if [[ -n "${MOUNT_POINT}" ]]; then
    hdiutil detach "${MOUNT_POINT}" -quiet >/dev/null 2>&1 || true
  fi
  [[ -z "${STAGED_APP}" ]] || rm -rf "${STAGED_APP}" 2>/dev/null || true
  [[ -z "${BUILD_LOG}" ]] || rm -f "${BUILD_LOG}" 2>/dev/null || true
  if [[ "${FINISHED}" != true && -n "${OLD_APP}" && -d "${OLD_APP}" ]]; then
    local app_pids=() pid
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] && app_pids+=("${pid}")
    done < <(production_app_pids)
    if (( ${#app_pids[@]} > 0 )); then
      stop_pids "failed replacement app" "${app_pids[@]}" >/dev/null 2>&1 || true
    fi
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
    rm -rf "${APP_PATH}" 2>/dev/null || true
    mv "${OLD_APP}" "${APP_PATH}" 2>/dev/null || true
  fi
  [[ -z "${OLD_APP}" ]] || rm -rf "${OLD_APP}" 2>/dev/null || true

  if [[ "${STOPPED_PRODUCTION}" == true && "${FINISHED}" != true && -d "${APP_PATH}" ]]; then
    echo "Upgrade did not finish; reopening the installed Corptie app." >&2
    open -na "${APP_PATH}" >/dev/null 2>&1 || true
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if production_is_running; then
  if [[ "${RESET_PRODUCTION_DATABASE}" != true ]]; then
    check_production_sessions
  else
    echo "Production database reset was explicitly requested; skipping unfinished-session inspection."
  fi
  if [[ "${CHECK_ONLY}" == true ]]; then
    exit 0
  fi
  if [[ "${RESET_PRODUCTION_DATABASE}" != true ]]; then
    # Close the small race between the first check and shutdown.
    sleep 1
    check_production_sessions
  fi
  stop_production
else
  echo "Production is not running."
  if [[ "${CHECK_ONLY}" == true ]]; then
    exit 0
  fi
fi

if [[ "${RESET_PRODUCTION_DATABASE}" == true ]]; then
  reset_production_database
fi

echo "Building production installers from the current checkout..."
BUILD_LOG="$(mktemp /tmp/corptie-production-build-XXXXXX)"
"${ROOT}/scripts/package-macos-installer.sh" | tee "${BUILD_LOG}"
PKG_PATH="$(sed -n 's/^Built production installer package: //p' "${BUILD_LOG}" | tail -1)"
DMG_PATH="$(sed -n 's/^Built production dmg: //p' "${BUILD_LOG}" | tail -1)"
if [[ ! -f "${PKG_PATH}" || ! -f "${DMG_PATH}" ]]; then
  echo "The production installer script did not produce the expected PKG and DMG." >&2
  exit 1
fi

echo "Mounting ${DMG_PATH}..."
MOUNT_POINT="$(hdiutil attach "${DMG_PATH}" -nobrowse -readonly \
  | awk -F '\t' '$NF ~ /^\/Volumes\// { print $NF; exit }')"
if [[ -z "${MOUNT_POINT}" || ! -d "${MOUNT_POINT}/Corptie.app" ]]; then
  echo "The generated DMG does not contain Corptie.app." >&2
  exit 1
fi

STAGED_APP="/Applications/.Corptie.app.new.$$"
OLD_APP="/Applications/.Corptie.app.old.$$"
rm -rf "${STAGED_APP}" "${OLD_APP}"
echo "Staging the new production app in /Applications..."
/usr/bin/ditto "${MOUNT_POINT}/Corptie.app" "${STAGED_APP}"
xattr -cr "${STAGED_APP}" 2>/dev/null || true
[[ -x "${STAGED_APP}/Contents/MacOS/Corptie" ]] || {
  echo "The staged app has no executable." >&2
  exit 1
}
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${STAGED_APP}/Contents/Info.plist")" == "com.corptie.mac" ]] || {
  echo "The staged app has an unexpected bundle identifier." >&2
  exit 1
}

if [[ -d "${APP_PATH}" ]]; then
  mv "${APP_PATH}" "${OLD_APP}"
fi
if ! mv "${STAGED_APP}" "${APP_PATH}"; then
  [[ ! -d "${OLD_APP}" ]] || mv "${OLD_APP}" "${APP_PATH}"
  echo "Could not install the new app." >&2
  exit 1
fi
STAGED_APP=""

hdiutil detach "${MOUNT_POINT}" -quiet
MOUNT_POINT=""

echo "Opening the newly installed Corptie app..."
open -na "${APP_PATH}"
health_attempts=$((HEALTH_TIMEOUT_SECONDS * 2))
for ((attempt = 1; attempt <= health_attempts; attempt += 1)); do
  if curl --fail --silent --max-time 1 "${BACKEND_URL}/health" \
    | "${NODE_BIN}" -e '
      let input="";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const health = JSON.parse(input);
        process.exit(
          health.service === "corptie-backend"
            && health.ok === true
            && health.storeReady === true
            && health.maintenance === false
            ? 0
            : 1
        );
      });
      ' >/dev/null 2>&1; then
    FINISHED=true
    [[ -z "${OLD_APP}" ]] || rm -rf "${OLD_APP}"
    OLD_APP=""
    echo "Production upgrade complete."
    echo "Installed app: ${APP_PATH}"
    echo "Installer package: ${PKG_PATH}"
    echo "Disk image: ${DMG_PATH}"
    exit 0
  fi
  if (( attempt % 20 == 0 )); then
    elapsed_seconds=$((attempt / 2))
    if launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1; then
      echo "Waiting for production backend initialization (${elapsed_seconds}s/${HEALTH_TIMEOUT_SECONDS}s)..."
    else
      echo "Production backend LaunchAgent is not loaded after ${elapsed_seconds}s." >&2
      break
    fi
  fi
  sleep 0.5
done

echo "The new app opened, but its production backend did not become healthy at ${BACKEND_URL}." >&2
echo "Production backend diagnostics:" >&2
launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" 2>&1 | tail -80 >&2 || true
if [[ -f "${BACKEND_STDERR_LOG}" ]]; then
  echo "Recent backend stderr (${BACKEND_STDERR_LOG}):" >&2
  tail -80 "${BACKEND_STDERR_LOG}" >&2 || true
fi
if [[ -f "${BACKEND_STDOUT_LOG}" ]]; then
  echo "Recent backend stdout (${BACKEND_STDOUT_LOG}):" >&2
  tail -80 "${BACKEND_STDOUT_LOG}" >&2 || true
fi
exit 1
