#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Copets.app"
APP_DIR="/Applications/${APP_NAME}"
EXECUTABLE="${ROOT}/apps/macos/.build/arm64-apple-macosx/debug/CopetsMac"

swift build --package-path "${ROOT}/apps/macos"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${EXECUTABLE}" "${APP_DIR}/Contents/MacOS/Copets"
cat > "${APP_DIR}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Copets</string>
  <key>CFBundleIdentifier</key>
  <string>com.copets.mac</string>
  <key>CFBundleName</key>
  <string>Copets</string>
  <key>CFBundleDisplayName</key>
  <string>Copets</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo "Installed ${APP_DIR}"
echo "Start the production backend with: ${ROOT}/scripts/start-backend-production.sh"
