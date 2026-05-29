#!/usr/bin/env bash
# electron-builder 需下载 win32 Electron；终端常不走系统代理导致 GitHub connection reset。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ELECTRON_VERSION="$(node -p "require('electron/package.json').version")"
CACHE_ZIP="${HOME}/Library/Caches/electron/electron-v${ELECTRON_VERSION}-win32-x64.zip"

proxy_from_macos() {
  local enable host port
  enable="$(scutil --proxy 2>/dev/null | awk '/^[[:space:]]*HTTPEnable :/{print $3; exit}')"
  host="$(scutil --proxy 2>/dev/null | awk '/^[[:space:]]*HTTPProxy :/{print $3; exit}')"
  port="$(scutil --proxy 2>/dev/null | awk '/^[[:space:]]*HTTPPort :/{print $3; exit}')"
  if [[ "${enable:-0}" == "1" && -n "${host:-}" && -n "${port:-}" ]]; then
    echo "http://${host}:${port}"
    return 0
  fi
  return 1
}

PROXY_URL=""
if PROXY_URL="$(proxy_from_macos)"; then
  export http_proxy="$PROXY_URL"
  export https_proxy="$PROXY_URL"
  export HTTP_PROXY="$PROXY_URL"
  export HTTPS_PROXY="$PROXY_URL"
  export ALL_PROXY="$PROXY_URL"
  echo "[dist-win] 使用系统代理: $PROXY_URL"
else
  echo "[dist-win] 未检测到系统 HTTP 代理"
fi

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
  echo "[dist-win] 警告: 缺少 bundles/win32-x64/engine-upstream.exe（从 GitHub Actions artifact 放入后再打包更完整）"
fi

exec npx electron-builder --win "$@"
