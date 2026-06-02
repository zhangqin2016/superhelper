#!/usr/bin/env bash
# electron-builder 需下载 win32 Electron；终端常不走系统代理导致 GitHub connection reset。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$(dirname "$0")/setup-proxy.sh"

ELECTRON_VERSION="$(node -p "require('electron/package.json').version")"
CACHE_ZIP="${HOME}/Library/Caches/electron/electron-v${ELECTRON_VERSION}-win32-x64.zip"

download_electron_zip() {
  local url="$1"
  local label="$2"
  local use_proxy="${3:-0}"
  echo "[dist-win] 下载 ${label}…"
  local opts=(-fSL --connect-timeout 30 --max-time 0 --retry 10 --retry-delay 2 --retry-all-errors -C - -o "$CACHE_ZIP" "$url")
  if [[ "$use_proxy" == "1" && -n "${https_proxy:-}" ]]; then
    opts=(--proxy "$https_proxy" "${opts[@]}")
  fi
  # 续传：保留已有部分文件
  curl "${opts[@]}"
}

if [[ -f "$CACHE_ZIP" ]]; then
  # 粗略校验：完整包通常 >100MB
  size="$(wc -c < "$CACHE_ZIP" | tr -d ' ')"
  if [[ "${size:-0}" -lt 100000000 ]]; then
    echo "[dist-win] 缓存不完整 (${size} bytes)，重新下载"
    rm -f "$CACHE_ZIP"
  else
    echo "[dist-win] 使用已有缓存: $CACHE_ZIP ($(du -h "$CACHE_ZIP" | awk '{print $1}'))"
  fi
fi

if [[ ! -f "$CACHE_ZIP" ]]; then
  echo "[dist-win] 预下载 Electron ${ELECTRON_VERSION} win32-x64"
  mkdir -p "$(dirname "$CACHE_ZIP")"
  GH_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip"
  MIRROR_URL="https://npmmirror.com/mirrors/electron/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip"
  # 国内直连镜像通常比走代理拉 GitHub 更稳
  if ! download_electron_zip "$MIRROR_URL" "npmmirror（直连）" 0; then
    rm -f "$CACHE_ZIP"
    download_electron_zip "$GH_URL" "GitHub（代理）" 1
  fi
  echo "[dist-win] 已缓存 $(du -h "$CACHE_ZIP" | awk '{print $1}')"
fi

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

if [[ ! -f "bundles/win32-x64/engine-upstream.exe" && ! -f "bundles/win32-x64/claude.exe" ]]; then
  echo "[dist-win] 错误: 缺少 bundles/win32-x64/engine-upstream.exe"
  echo "[dist-win] 从 GitHub Actions「Bundle Windows CLI」下载 artifact 后放入该路径"
  exit 1
fi

echo "[dist-win] Windows 安装包仅包含 bundles/win32-x64（不含 Mac runtime）"

node scripts/purge-macos-junk.mjs --check

echo "[dist-win] 确保 sharp win32-x64 原生包已安装"
npm install --os=win32 --cpu=x64 --include=optional

# 必须打 x64：在 Apple Silicon 上省略 --x64 会产出 win-arm64，普通 Intel/AMD PC 无法运行。
exec npx electron-builder --win --x64 "$@"
