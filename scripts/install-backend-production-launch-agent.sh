#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="${ROOT}/apps/backend"
NODE_BIN=$(volta which node 2>/dev/null || readlink -f "$(command -v node)" 2>/dev/null || command -v node)
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
  <string>${LOG_DIR}/backend.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/backend.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "${PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl kickstart -k "gui/$(id -u)/com.corptie.backend"

echo "Installed and started ${PLIST}"
echo "Logs: ${LOG_DIR}/backend.out.log and ${LOG_DIR}/backend.err.log"
