#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="${ROOT}/apps/backend"
NODE_BIN=""
# LaunchAgents must not depend on interactive shell startup files being safe.
for candidate in "${HOME}"/.nvm/versions/node/*/bin/node "${HOME}"/.fnm/node-versions/*/installation/bin/node "${HOME}/.asdf/shims/node" "${HOME}/.local/share/mise/shims/node" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -x "${candidate}" ] && "${candidate}" -e 'require("node:sqlite").DatabaseSync' >/dev/null 2>&1; then
    NODE_BIN="${candidate}"
    break
  fi
done
if [ -z "${NODE_BIN}" ]; then
  echo "Node.js 22.13 or newer with node:sqlite was not found in NVM/Homebrew/system paths." >&2
  exit 1
fi
PLIST="${HOME}/Library/LaunchAgents/com.corptie.backend.plist"
LOG_DIR="${HOME}/Library/Logs/Corptie"
DEFAULT_WORKSPACE="${CORPTIE_DEFAULT_WORKSPACE:-${HOME}/corptie}"

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}" "${DEFAULT_WORKSPACE}"

cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.corptie.backend</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BACKEND_DIR}/src/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${DEFAULT_WORKSPACE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CORPTIE_ENV</key>
    <string>production</string>
    <key>CORPTIE_BACKEND_PORT</key>
    <string>47321</string>
    <key>CORPTIE_DEFAULT_WORKSPACE</key>
    <string>${DEFAULT_WORKSPACE}</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "${PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"

echo "Installed ${PLIST}; CorptieMac will start it when the App opens."
echo "Logs: ${LOG_DIR}/backend.out.log and ${LOG_DIR}/backend.err.log"
