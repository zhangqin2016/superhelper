#!/usr/bin/env bash
# Mac 安装包：暂时只内置 Python runtime，不内置 LibreOffice；签名阶段需跳过 bundles 内二进制签名。
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

exec npx electron-builder --mac "--${ARCH}" "${@:2}"
