#!/usr/bin/env bash
# Rebuild node-pty for the Electron version in package.json.
# Required on macOS when default node-gyp uses macosx-version-min=10.7 (breaks libc++ on newer OS).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ELECTRON_VERSION="$(node -p "require('electron/package.json').version")"
SDKROOT="$(xcrun -sdk macosx --show-sdk-path)"

export SDKROOT
export MACOSX_DEPLOYMENT_TARGET=11.0
export GYP_DEFINES="mac_deployment_target=11.0"
# CLT-only installs: avoid gyp CLTVersion() pkgutil receipt failure
export GYP_XCODE_VERSION="${GYP_XCODE_VERSION:-1500}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"
export CC="clang"
export CXX="clang++"
export CPPFLAGS="-isysroot ${SDKROOT}"
export CXXFLAGS="-mmacosx-version-min=11.0 -isysroot ${SDKROOT} -stdlib=libc++ -I${SDKROOT}/usr/include/c++/v1"
export LDFLAGS="-mmacosx-version-min=11.0 -isysroot ${SDKROOT}"

ARCH="$(node -p "process.arch")"
ELECTRON_BIN="${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ -f "${ELECTRON_BIN}" ]] && file "${ELECTRON_BIN}" 2>/dev/null | grep -q arm64; then
  ARCH="arm64"
elif [[ "$(uname -m)" == "arm64" && "$ARCH" == "x64" ]]; then
  ARCH="arm64"
fi

echo "Rebuilding node-pty for Electron ${ELECTRON_VERSION} arch=${ARCH} (SDK: ${SDKROOT})"

cd node_modules/node-pty
rm -rf build
node "${ROOT}/node_modules/@electron/node-gyp/bin/node-gyp.js" rebuild \
  --target="${ELECTRON_VERSION}" \
  --arch="${ARCH}" \
  --dist-url=https://electronjs.org/headers

echo "OK: $(ls -la build/Release/pty.node)"
