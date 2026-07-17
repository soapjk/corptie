#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="/Applications/Corptie.app"
APP_EXECUTABLE="${APP_PATH}/Contents/MacOS/Corptie"
BACKEND_PORT="${CORPTIE_PRODUCTION_PORT:-47321}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
LAUNCH_AGENT_LABEL="com.corptie.backend"
LAUNCH_AGENT_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
CHECK_ONLY=false
MOUNT_POINT=""
STAGED_APP=""
OLD_APP=""
BUILD_LOG=""
STOPPED_PRODUCTION=false
FINISHED=false

usage() {
  cat <<'USAGE'
Usage: scripts/rebuild-install-restart-production.sh [--check-only]

Build the current checkout as a production installer, safely stop an idle
production app, install it into /Applications, and open the new version.

Options:
  --check-only  Only report whether production has unfinished sessions.
USAGE
}

for argument in "$@"; do
  case "${argument}" in
    --check-only) CHECK_ONLY=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: ${argument}" >&2; usage >&2; exit 64 ;;
  esac
done

find_node() {
  local login_node candidate
  login_node="$(/bin/zsh -lic 'command -v node' 2>/dev/null || true)"
  for candidate in \
    "${login_node}" \
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
  stop_pids "production app" "${app_pids[@]}"

  launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 \
    || launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT_PLIST}" >/dev/null 2>&1 \
    || true

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && backend_pids+=("${pid}")
  done < <(lsof -tiTCP:"${BACKEND_PORT}" -sTCP:LISTEN 2>/dev/null || true)
  stop_pids "production backend" "${backend_pids[@]}"

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
    stop_pids "failed replacement app" "${app_pids[@]}" >/dev/null 2>&1 || true
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
  check_production_sessions
  if [[ "${CHECK_ONLY}" == true ]]; then
    exit 0
  fi
  # Close the small race between the first check and shutdown.
  sleep 1
  check_production_sessions
  stop_production
else
  echo "Production is not running."
  if [[ "${CHECK_ONLY}" == true ]]; then
    exit 0
  fi
fi

echo "Building production installers from the current checkout..."
BUILD_LOG="$(mktemp /tmp/corptie-production-build-XXXXXX.log)"
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
for _ in {1..60}; do
  if curl --fail --silent --max-time 1 "${BACKEND_URL}/health" \
    | "${NODE_BIN}" -e '
        let input="";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => process.exit(JSON.parse(input).service === "corptie-backend" ? 0 : 1));
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
  sleep 0.5
done

echo "The new app opened, but its production backend did not become healthy at ${BACKEND_URL}." >&2
exit 1
