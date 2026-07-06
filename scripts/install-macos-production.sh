#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Corptie.app"
APP_DIR="/Applications/${APP_NAME}"
EXECUTABLE="${ROOT}/apps/macos/.build/arm64-apple-macosx/debug/CorptieMac"
ICON_ICNS_SOURCE="${ROOT}/apps/macos/Sources/CopetsMac/Resources/AppIcon.icns"
ICON_SOURCE="${ROOT}/apps/macos/Sources/CopetsMac/Resources/AppIcon.png"

swift build --package-path "${ROOT}/apps/macos"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${EXECUTABLE}" "${APP_DIR}/Contents/MacOS/Corptie"

if [ -f "${ICON_ICNS_SOURCE}" ]; then
  cp "${ICON_ICNS_SOURCE}" "${APP_DIR}/Contents/Resources/AppIcon.icns"
else
  ICONSET_DIR="$(mktemp -d /tmp/corptie-iconset-XXXXXX).iconset"
  mkdir -p "${ICONSET_DIR}"
  for size in 16 32 128 256 512; do
    sips -z "${size}" "${size}" "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_${size}x${size}.png" >/dev/null
    doubled=$((size * 2))
    sips -z "${doubled}" "${doubled}" "${ICON_SOURCE}" --out "${ICONSET_DIR}/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "${ICONSET_DIR}" -o "${APP_DIR}/Contents/Resources/AppIcon.icns"
  rm -rf "${ICONSET_DIR}"
fi

cat > "${APP_DIR}/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Corptie</string>
  <key>CFBundleIdentifier</key>
  <string>com.corptie.mac</string>
  <key>CFBundleName</key>
  <string>Corptie</string>
  <key>CFBundleDisplayName</key>
  <string>Corptie</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.1</string>
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
