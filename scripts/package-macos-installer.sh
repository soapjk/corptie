#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRODUCT_NAME="Corptie"
APP_NAME="${PRODUCT_NAME}.app"
BUILD_CFG="release"
ARCHIVE_DIR="${ROOT}/dist"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKEND_BUILD_ID="${TIMESTAMP}"
APP_VERSION="0.5.4"
APP_BUNDLE_PATH="/Applications/Corptie.app"
ICON_ICNS_SOURCE="${ROOT}/apps/macos/Sources/CopetsMac/Resources/AppIcon.icns"
ICON_SOURCE="${ROOT}/apps/macos/Sources/CopetsMac/Resources/AppIcon.png"

mkdir -p "${ARCHIVE_DIR}"
NODE_DISTRIBUTION="$(bash "${ROOT}/scripts/prepare-bundled-node.sh")"
export PATH="${NODE_DISTRIBUTION}/bin:${PATH}"

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
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources" "${APP_DIR}/Contents/Helpers"
cp "${NODE_DISTRIBUTION}/bin/node" "${APP_DIR}/Contents/Helpers/node"
mkdir -p "${APP_DIR}/Contents/Resources/licenses"
cp "${NODE_DISTRIBUTION}/LICENSE" "${APP_DIR}/Contents/Resources/licenses/Node.js-LICENSE"
printf 'Node.js %s (darwin-arm64)\n' "$(node --version)" > "${APP_DIR}/Contents/Resources/licenses/Node.js-version.txt"
cp "${BUILD_BIN}" "${APP_DIR}/Contents/MacOS/${PRODUCT_NAME}"
# SwiftPM can embed the build machine's Xcode toolchain as a fallback RPATH.
# Installed apps may search only system libraries or bundle-relative locations.
while IFS= read -r runtime_path; do
  case "${runtime_path}" in
    /usr/lib/*|/System/Library/*|@*) ;;
    *) install_name_tool -delete_rpath "${runtime_path}" "${APP_DIR}/Contents/MacOS/${PRODUCT_NAME}" ;;
  esac
done < <(otool -l "${BUILD_BIN}" | awk '/cmd LC_RPATH/ { getline; getline; sub(/^ *path /, ""); sub(/ \(offset [0-9]+\)$/, ""); print }')
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

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
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
    <string>${APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
  </dict>
</plist>
PLIST

BACKEND_SOURCE="${ROOT}/apps/backend"
BACKEND_DEST="${APP_DIR}/Contents/Resources/backend"
(
  cd "${BACKEND_SOURCE}"
  npm ci --no-audit --no-fund
  npm run build:native
)
mkdir -p "${BACKEND_DEST}"
cp -R "${BACKEND_SOURCE}/package.json" "${BACKEND_SOURCE}/package-lock.json" "${BACKEND_SOURCE}/src" "${BACKEND_SOURCE}/scripts" "${BACKEND_SOURCE}/resources" "${BACKEND_DEST}/"
mkdir -p "${BACKEND_DEST}/native"
cp "${BACKEND_SOURCE}/native/corptie_native.node" "${BACKEND_DEST}/native/"
# Cargo embeds the build directory as LC_ID_DYLIB. Give the packaged copy a
# relocatable identity before signing; never alter the development artifact.
install_name_tool -id '@loader_path/corptie_native.node' "${BACKEND_DEST}/native/corptie_native.node"
if [ -d "${BACKEND_SOURCE}/node_modules" ]; then
  # Feature worktrees may share the repository's installed dependencies through
  # a symlink. App bundles cannot be signed when that link points outside the
  # bundle, so materialize dependencies (including npm's .bin links) here.
  cp -RL "${BACKEND_SOURCE}/node_modules" "${BACKEND_DEST}/"
fi

cat > "${APP_DIR}/Contents/Resources/corptie-backend-launch.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"
DEFAULT_WORKSPACE="${CORPTIE_DEFAULT_WORKSPACE:-${HOME}/corptie}"
export CORPTIE_ENV="production"
export CORPTIE_BACKEND_PORT="${CORPTIE_BACKEND_PORT:-47321}"
export CORPTIE_DEFAULT_WORKSPACE="${DEFAULT_WORKSPACE}"

# Production must always use this app's runtime, regardless of NODE_BIN/PATH.
NODE_BIN="${SCRIPT_DIR}/../Helpers/node"
if [ ! -x "${NODE_BIN}" ]; then
  echo "Corptie's bundled Node.js runtime is missing. Please reinstall Corptie." >&2
  exit 1
fi
unset NODE_OPTIONS NODE_PATH

# launchd starts GUI apps with a minimal PATH.  Keep both node and npm-installed
# CLIs (including lark-cli) discoverable in that environment.
NODE_DIR="$(dirname "${NODE_BIN}")"
export PATH="${NODE_DIR}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

mkdir -p "${DEFAULT_WORKSPACE}"
cd "${DEFAULT_WORKSPACE}"
exec "${NODE_BIN}" "${BACKEND_DIR}/src/server.mjs"
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
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CORPTIE_ENV</key>
      <string>production</string>
      <key>CORPTIE_BACKEND_PORT</key>
      <string>47321</string>
      <key>CORPTIE_DEFAULT_WORKSPACE</key>
      <string>__CORPTIE_USER_HOME__/corptie</string>
      <key>CORPTIE_BACKEND_BUILD_ID</key>
      <string>${BACKEND_BUILD_ID}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>__CORPTIE_USER_HOME__/Library/Logs/Corptie/backend.out.log</string>
    <key>StandardErrorPath</key>
    <string>__CORPTIE_USER_HOME__/Library/Logs/Corptie/backend.err.log</string>
  </dict>
</plist>
PLIST

xattr -cr "${STAGING_ROOT}" 2>/dev/null || true

APP_SIGNING_IDENTITY="${CORPTIE_APP_SIGNING_IDENTITY:--}"
SIGN_FLAGS=(--force --sign "${APP_SIGNING_IDENTITY}")
if [[ "${APP_SIGNING_IDENTITY}" == "-" ]]; then
  echo "Warning: building an ad-hoc signed app; macOS privacy permissions may need to be granted again after upgrades." >&2
else
  # Timestamping contacts Apple. Release operators must authorize that service.
  SIGN_FLAGS+=(--options runtime --timestamp)
fi
# Sign nested Mach-O code explicitly, before sealing the outer bundle. Native
# addons share the app's identity, so Node does not need disabled library validation.
while IFS= read -r -d '' native_file; do
  if file -b "${native_file}" | /usr/bin/grep -q 'Mach-O'; then
    case "${native_file}" in
      *.node|*/node-pty/prebuilds/*/spawn-helper)
        codesign "${SIGN_FLAGS[@]}" "${native_file}" ;;
      *)
        # Retain external Provider executable identities and entitlements.
        # They must not become Corptie-owned permission requesters.
        codesign --verify --strict "${native_file}"
        ;;
    esac
  fi
done < <(find "${BACKEND_DEST}" -type f -print0)
codesign "${SIGN_FLAGS[@]}" --identifier com.corptie.backend.node \
  --entitlements "${ROOT}/scripts/bundled-node-entitlements.plist" "${APP_DIR}/Contents/Helpers/node"
codesign "${SIGN_FLAGS[@]}" "${APP_DIR}"
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
# Test the actual signed runtime and packaged addons, with no system Node in PATH.
/usr/bin/env -i HOME="${HOME}" PATH=/usr/bin:/bin \
  "${APP_DIR}/Contents/Helpers/node" "${ROOT}/scripts/verify-bundled-node.mjs" "${APP_DIR}"
echo "Bundled Node binary size (bytes): $(stat -f %z "${APP_DIR}/Contents/Helpers/node")"

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
Node.js 已内置，无需单独安装；外部 Agent Provider 和其工具仍需各自配置。
Node.js 及其第三方许可证位于 `Contents/Resources/licenses/Node.js-LICENSE`。
INSTALL_README

hdiutil create "${DMG_NAME}" \
  -volname "Corptie Installer" \
  -fs HFS+ \
  -srcfolder "${Dmg_STAGING}" \
  -ov -format UDZO

echo "Built production installer package: ${PKG_FILE}"
echo "Built production dmg: ${DMG_NAME}"
