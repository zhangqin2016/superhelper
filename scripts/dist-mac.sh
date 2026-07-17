#!/usr/bin/env bash
# Mac 安装包内置基础 Python 运行时（当前架构原生 venv），使 pillow/opencv/numpy/文档解析
# 开箱即用；LibreOffice 与可选 runtime-packs 仍按需下载。和 Windows 同一套发布策略。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$(dirname "$0")/setup-proxy.sh"

ARCH="${1:-arm64}"
if [[ "$ARCH" != "arm64" && "$ARCH" != "x64" ]]; then
  echo "[dist-mac] 错误: 架构必须是 arm64 或 x64，当前: ${ARCH}" >&2
  exit 1
fi

MAC_VENV_PY="bundles/darwin-${ARCH}/runtime/venv/bin/python3"
if [[ ! -e "$MAC_VENV_PY" ]]; then
  echo "[dist-mac] 错误: 缺少内置 Python 运行时 ($MAC_VENV_PY)。" >&2
  echo "[dist-mac] 先在 ${ARCH} Mac 上生成运行时: npm run build:runtime -- --platform darwin-${ARCH}" >&2
  echo "[dist-mac] (客户端无 Python 会导致 pillow/文档处理等不可用)" >&2
  exit 1
fi
echo "[dist-mac] 打包 darwin-${ARCH}（内置 Python 运行时；LibreOffice/runtime-packs 按需下载）"
node scripts/fix-runtime-symlinks.mjs
node scripts/purge-macos-junk.mjs --check

# mac zip 也走 7za。压缩级别过高容易在 Apple Silicon 上被系统终止。
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

# --- 给内置 Python/Node 运行时补签 (hardened + disable-library-validation) ------
# venv python 是加载按需下载的 runtime-pack 原生扩展(rembg 的 onnxruntime、numba
# 等,由第三方签名)的"宿主进程"。它同样在 signIgnore 排除的 bundles/ 下,原先只靠
# App 的 --deep 兜底签 —— 而 --deep 不可靠地把 entitlements 传给嵌套二进制,导致
# hardened 的 python 没有 disable-library-validation,dlopen 外部签名的 .so 时被
# taskgated 以 "Library load disallowed by system policy" 拒绝 → 依赖健康检查失败
# ("下载完成、健康检查时操作失败")。这里按引擎同样的方式单独补签宿主解释器。
RUNTIME_DIR="${APP_PATH}/Contents/Resources/bundles/darwin-${ARCH}/runtime"
for RT_BIN in \
  "$RUNTIME_DIR"/python/*/bin/python3.* \
  "$RUNTIME_DIR"/venv/bin/python3 \
  "$RUNTIME_DIR"/bin/node; do
  for RT_FILE in $RT_BIN; do
    [[ -f "$RT_FILE" ]] || continue
    if codesign --force --options runtime \
      --entitlements "${ROOT}/build/entitlements.mac.inherit.plist" \
      --sign "${SIGN_ID}" "$RT_FILE" 2>/dev/null; then
      echo "[dist-mac] 补签运行时二进制 $(basename "$RT_FILE")"
    else
      echo "[dist-mac] 警告: 补签失败(跳过) $RT_FILE" >&2
    fi
  done
done

# electron-builder 在没有可用 Developer ID 时，某些架构会直接跳过 App
# bundle 签名。未签名的 .app 仍能被打包，但发布后会在更严格的 macOS
# 环境里出现启动/更新问题。真实证书签名通过时不覆盖；只有验证失败才用
# ad-hoc 兜底，并保留 hardened runtime entitlements。
if ! codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
  APP_SIGN_ID="${MAC_APP_SIGN_ID:-$SIGN_ID}"
  echo "[dist-mac] App bundle 未签名或签名无效，补签 (identity: ${APP_SIGN_ID})"
  codesign --force --deep --options runtime \
    --entitlements "${ROOT}/build/entitlements.mac.plist" \
    --sign "${APP_SIGN_ID}" "$APP_PATH"
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
echo "[dist-mac] App bundle 签名校验通过"
