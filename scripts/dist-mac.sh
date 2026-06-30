#!/usr/bin/env bash
# Mac 安装包：内置 Python + LibreOffice runtime；签名阶段需跳过 bundles 内二进制签名。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$(dirname "$0")/setup-proxy.sh"

ARCH="${1:-arm64}"
if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
  echo "[dist-mac] 错误: 架构必须是 arm64 或 x64，当前: ${ARCH}" >&2
  exit 1
fi

echo "[dist-mac] 打包 darwin-${ARCH}（签名 bundles 已跳过）"
node scripts/fix-runtime-symlinks.mjs
node scripts/purge-macos-junk.mjs --check

# mac zip 也走 7za。运行时变大后默认压缩级别容易在 Apple Silicon 上被系统终止。
export ELECTRON_BUILDER_COMPRESSION_LEVEL="${ELECTRON_BUILDER_COMPRESSION_LEVEL:-5}"

npx electron-builder --mac "--${ARCH}" "${@:2}"

# --- 给 OpenCode 引擎二进制补签 ---------------------------------------------
# build.mac.signIgnore 排除了 bundles/，所以 bun 编译的 `opencode` 引擎未被签名。
# App 开了 hardenedRuntime，macOS taskgated 会把未签名/签名不匹配的嵌套二进制直接
# SIGKILL（"Code Signature Invalid"），在 App 里表现为 "engine stopped
# unexpectedly (code null)"，引擎根本起不来。这里用 runtime 选项 + inherit
# entitlements（allow-jit / disable-library-validation）重新签名。默认 ad-hoc(-)，
# 可用 MAC_ENGINE_SIGN_ID 传真实 Developer ID 证书。
APP_DIR="dist/mac-${ARCH}"
[[ "$ARCH" == "x64" ]] && APP_DIR="dist/mac"
APP_PATH="$(/usr/bin/find "$APP_DIR" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
if [[ -z "$APP_PATH" ]]; then
  echo "[dist-mac] 错误: 未找到 ${APP_DIR}/*.app，无法给引擎补签" >&2
  exit 1
fi
ENGINE="${APP_PATH}/Contents/Resources/bundles/darwin-${ARCH}/opencode/bin/opencode"
if [[ ! -f "$ENGINE" ]]; then
  echo "[dist-mac] 错误: 缺少引擎二进制 ${ENGINE}" >&2
  exit 1
fi
SIGN_ID="${MAC_ENGINE_SIGN_ID:--}"
echo "[dist-mac] 给 OpenCode 引擎补签 (identity: ${SIGN_ID})"
codesign --force --options runtime \
  --entitlements "${ROOT}/build/entitlements.mac.inherit.plist" \
  --sign "${SIGN_ID}" "$ENGINE"
codesign --verify --strict --verbose=2 "$ENGINE"
echo "[dist-mac] 引擎签名校验通过"
