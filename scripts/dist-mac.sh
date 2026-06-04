#!/usr/bin/env bash
# Mac 安装包：暂时只内置 Python runtime，不内置 LibreOffice；签名阶段需跳过 bundles 内二进制签名。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$(dirname "$0")/setup-proxy.sh"

echo "[dist-mac] 打包 darwin-arm64（新款 Mac 默认架构，签名 bundles 已跳过）"
node scripts/fix-runtime-symlinks.mjs
node scripts/purge-macos-junk.mjs --check

exec npx electron-builder --mac --arm64 "$@"
