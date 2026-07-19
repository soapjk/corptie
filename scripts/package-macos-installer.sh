#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRODUCT_NAME="Corptie"
APP_NAME="${PRODUCT_NAME}.app"
BUILD_CFG="release"
ARCHIVE_DIR="${ROOT}/dist"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
APP_VERSION="0.1.1"
APP_BUNDLE_PATH="/Applications/Corptie.app"
ICON_ICNS_SOURCE="${ROOT}/apps/macos/Sources/CopetsMac/Resources/AppIcon.icns"
ICON_SOURCE="${ROOT}/apps/macos/Sources/CopetsMac/Resources/AppIcon.png"

mkdir -p "${ARCHIVE_DIR}"

echo "Building for production..."
swift build --package-path "${ROOT}/apps/macos" -c "${BUILD_CFG}"

BUILD_BIN="${ROOT}/apps/macos/.build/arm64-apple-macosx/${BUILD_CFG}/CorptieMac"
if [ ! -f "${BUILD_BIN}" ]; then
  echo "Build binary not found: ${BUILD_BIN}" >&2
  exit 1
fi

STAGING_ROOT="$(mktemp -d /tmp/corptie-pkg-staging-XXXXXX)"
Dmg_STAGING="$(mktemp -d /tmp/corptie-dmg-staging-XXXXXX)"
SCRIPTS_DIR="$(mktemp -d /tmp/corptie-pkg-scripts-XXXXXX)"
trap 'rm -rf "${STAGING_ROOT}" "${Dmg_STAGING}" "${SCRIPTS_DIR}"' EXIT

APP_DIR="${STAGING_ROOT}/Applications/${APP_NAME}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${BUILD_BIN}" "${APP_DIR}/Contents/MacOS/${PRODUCT_NAME}"
RESOURCE_BUNDLE="${ROOT}/apps/macos/.build/arm64-apple-macosx/${BUILD_CFG}/CorptieMac_CorptieMac.bundle"
if [ -d "${RESOURCE_BUNDLE}" ]; then
  cp -R "${RESOURCE_BUNDLE}" "${APP_DIR}/Contents/Resources/"
fi

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

BACKEND_SOURCE="${ROOT}/apps/backend"
BACKEND_DEST="${APP_DIR}/Contents/Resources/backend"
mkdir -p "${BACKEND_DEST}"
cp -R "${BACKEND_SOURCE}/package.json" "${BACKEND_SOURCE}/package-lock.json" "${BACKEND_SOURCE}/src" "${BACKEND_SOURCE}/scripts" "${BACKEND_SOURCE}/resources" "${BACKEND_DEST}/"
if [ -d "${BACKEND_SOURCE}/node_modules" ]; then
  cp -R "${BACKEND_SOURCE}/node_modules" "${BACKEND_DEST}/"
fi

cat > "${APP_DIR}/Contents/Resources/corptie-backend-launch.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"
export CORPTIE_ENV="production"
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47321}"

NODE_BIN="${NODE_BIN:-}"
if [ -z "${NODE_BIN}" ]; then
  LOGIN_NODE="$(/bin/zsh -lic 'command -v node' 2>/dev/null || true)"
  for candidate in \
    "${LOGIN_NODE}" \
    "${HOME}"/.nvm/versions/node/*/bin/node \
    "${HOME}"/.fnm/node-versions/*/installation/bin/node \
    "${HOME}/.asdf/shims/node" \
    "${HOME}/.local/share/mise/shims/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node" \
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
    "$(command -v node 2>/dev/null || true)"; do
    if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${NODE_BIN}" ]; then
  echo "Node.js not found in PATH. Please install Node.js and retry." >&2
  exit 1
fi

# launchd starts GUI apps with a minimal PATH.  Keep both node and npm-installed
# CLIs (including lark-cli) discoverable in that environment.
NODE_DIR="$(dirname "${NODE_BIN}")"
export PATH="${NODE_DIR}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

cd "${BACKEND_DIR}"
exec "${NODE_BIN}" src/server.mjs
LAUNCHER
chmod +x "${APP_DIR}/Contents/Resources/corptie-backend-launch.sh"

cat > "${APP_DIR}/Contents/Resources/com.corptie.backend.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.corptie.backend</string>
    <key>ProgramArguments</key>
    <array>
      <string>${APP_BUNDLE_PATH}/Contents/Resources/corptie-backend-launch.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CORPTIE_ENV</key>
      <string>production</string>
      <key>CORPTIE_BACKEND_PORT</key>
      <string>47321</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
  </dict>
</plist>
PLIST

xattr -cr "${STAGING_ROOT}" 2>/dev/null || true

PKG_FILE="${ARCHIVE_DIR}/Corptie-Production-${APP_VERSION}-${TIMESTAMP}.pkg"
pkgbuild \
  --root "${STAGING_ROOT}" \
  --identifier "com.corptie.pkg" \
  --version "${APP_VERSION}" \
  --install-location / \
  --scripts "${SCRIPTS_DIR}" \
  "${PKG_FILE}"

DMG_NAME="${ARCHIVE_DIR}/Corptie-Production-${APP_VERSION}-${TIMESTAMP}.dmg"

mkdir -p "${Dmg_STAGING}"
cp -R "${APP_DIR}" "${Dmg_STAGING}/"
ln -s /Applications "${Dmg_STAGING}/Applications"

mkdir -p "${Dmg_STAGING}/.background"
cat > "${Dmg_STAGING}/.background/README.txt" <<'DMGINFO'
Corptie 安装说明

1) 将 Corptie.app 拖拽到右侧的 Applications
2) 在 Corptie.app 首次启动时，软件会显示后端初始化提示（如未配置启动）
3) 按提示完成后即可使用
DMGINFO

mkdir -p "${Dmg_STAGING}/.install" 
cat > "${Dmg_STAGING}/.install/Corptie-Readme.md" <<'INSTALL_README'
# Corptie 安装说明

此安装包为标准拖拽式安装：

- 将 `Corptie.app` 拖到 `Applications`
- 启动 Corptie
- 如果提示后端未启动，先在首次设置页点击“启动后端服务”按钮

后端文件已随应用一起打包在 `Corptie.app/Contents/Resources/backend`。
INSTALL_README

hdiutil create "${DMG_NAME}" \
  -volname "Corptie Installer" \
  -fs HFS+ \
  -srcfolder "${Dmg_STAGING}" \
  -ov -format UDZO

echo "Built production installer package: ${PKG_FILE}"
echo "Built production dmg: ${DMG_NAME}"
