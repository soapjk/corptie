#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="${ROOT}/apps/backend"
NODE_BIN=""
LOGIN_NODE="$(/bin/zsh -lic 'command -v node' 2>/dev/null || true)"
for candidate in "${LOGIN_NODE}" "${HOME}"/.nvm/versions/node/*/bin/node "${HOME}"/.fnm/node-versions/*/installation/bin/node "${HOME}/.asdf/shims/node" "${HOME}/.local/share/mise/shims/node" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -x "${candidate}" ]; then NODE_BIN="${candidate}"; break; fi
done
if [ -z "${NODE_BIN}" ]; then
  echo "Node.js not found in NVM/Homebrew/system paths." >&2
  exit 1
fi
PLIST="${HOME}/Library/LaunchAgents/com.corptie.backend.plist"
LOG_DIR="${HOME}/Library/Logs/Corptie"

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"

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
  <string>${BACKEND_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CORPTIE_ENV</key>
    <string>production</string>
    <key>CORPTIE_BACKEND_PORT</key>
    <string>47321</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "${PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl kickstart -k "gui/$(id -u)/com.corptie.backend"

echo "Installed and started ${PLIST}"
echo "Logs: ${LOG_DIR}/backend.out.log and ${LOG_DIR}/backend.err.log"
