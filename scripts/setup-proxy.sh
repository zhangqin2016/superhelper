#!/usr/bin/env bash
# Source this in other dist scripts to set up electron mirrors + macOS proxy.
set -euo pipefail

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

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

if PROXY_URL="$(proxy_from_macos)"; then
  export http_proxy="$PROXY_URL"
  export https_proxy="$PROXY_URL"
  export HTTP_PROXY="$PROXY_URL"
  export HTTPS_PROXY="$PROXY_URL"
  export ALL_PROXY="$PROXY_URL"
  echo "[setup-proxy] 使用系统代理: $PROXY_URL"
else
  echo "[setup-proxy] 未检测到系统 HTTP 代理，使用直连"
fi
