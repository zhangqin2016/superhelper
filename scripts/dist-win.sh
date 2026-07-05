#!/usr/bin/env bash
# electron-builder 需下载 win32 Electron；终端常不走系统代理导致 GitHub connection reset。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source "$(dirname "$0")/setup-proxy.sh"

builder_args=()

if [[ "${LILY_REQUIRE_WIN_SIGNING:-0}" == "1" ]]; then
  has_pfx=0
  if { [[ -n "${WIN_CSC_LINK:-}" ]] || [[ -n "${CSC_LINK:-}" ]]; } && \
     { [[ -n "${WIN_CSC_KEY_PASSWORD:-}" ]] || [[ -n "${CSC_KEY_PASSWORD:-}" ]]; }; then
    has_pfx=1
  fi

  has_azure=0
  if [[ -n "${AZURE_TENANT_ID:-}" && -n "${AZURE_CLIENT_ID:-}" && -n "${AZURE_CLIENT_SECRET:-}" && \
        -n "${LILY_AZURE_SIGN_ENDPOINT:-}" && -n "${LILY_AZURE_SIGN_ACCOUNT:-}" && \
        -n "${LILY_AZURE_SIGN_PROFILE:-}" && -n "${LILY_AZURE_SIGN_PUBLISHER:-}" ]]; then
    has_azure=1
  fi

  if [[ "$has_pfx" == "0" && "$has_azure" == "0" ]]; then
    cat >&2 <<'EOF'
[dist-win] 错误: 已要求 Windows 强制签名，但没有找到签名配置。

任选一种方式配置后重试:

1) PFX/OV 证书:
   export WIN_CSC_LINK=/absolute/path/codesign.pfx
   export WIN_CSC_KEY_PASSWORD='pfx-password'
   export LILY_WIN_PUBLISHER_NAME='证书里的发布者名称'

2) Microsoft Trusted Signing:
   export AZURE_TENANT_ID='...'
   export AZURE_CLIENT_ID='...'
   export AZURE_CLIENT_SECRET='...'
   export LILY_AZURE_SIGN_ENDPOINT='https://...codesigning.azure.net/'
   export LILY_AZURE_SIGN_ACCOUNT='...'
   export LILY_AZURE_SIGN_PROFILE='...'
   export LILY_AZURE_SIGN_PUBLISHER='证书里的发布者名称'
EOF
    exit 1
  fi

  builder_args+=("-c.forceCodeSigning=true")

  if [[ "$has_azure" == "1" ]]; then
    echo "[dist-win] 使用 Microsoft Trusted Signing 签名"
    builder_args+=(
      "-c.win.azureSignOptions.endpoint=${LILY_AZURE_SIGN_ENDPOINT}"
      "-c.win.azureSignOptions.codeSigningAccountName=${LILY_AZURE_SIGN_ACCOUNT}"
      "-c.win.azureSignOptions.certificateProfileName=${LILY_AZURE_SIGN_PROFILE}"
      "-c.win.azureSignOptions.publisherName=${LILY_AZURE_SIGN_PUBLISHER}"
    )
  else
    echo "[dist-win] 使用 PFX/CSC 证书签名"
    if [[ -n "${LILY_WIN_PUBLISHER_NAME:-}" ]]; then
      builder_args+=("-c.win.signtoolOptions.publisherName=${LILY_WIN_PUBLISHER_NAME}")
    fi
  fi
fi

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

if [[ ! -e "bundles/win32-x64/opencode/bin/opencode.exe" && ! -e "bundles/win32-x64/opencode/bin/opencode" ]]; then
  echo "[dist-win] 错误: 缺少 bundles/win32-x64/opencode 引擎"
  echo "[dist-win] 先运行: node scripts/fetch-opencode-engine.mjs --platform win32-x64"
  exit 1
fi

echo "[dist-win] Windows 默认安装包保持 slim：仅打入 win32-x64 引擎，不内置 runtime / runtime-packs 依赖"

node scripts/purge-macos-junk.mjs --check

echo "[dist-win] 确保 sharp win32-x64 原生包已安装"
npm install --os=win32 --cpu=x64 --include=optional

# 必须打 x64：在 Apple Silicon 上省略 --x64 会产出 win-arm64，普通 Intel/AMD PC 无法运行。
# electron-builder 对 NSIS 的 7z 包即使 compression=normal 仍会用 -mx=9。
# Windows 安装包默认不内置依赖 runtime；压缩等级保持中等，避免 macOS/ARM 交叉打包被系统终止。
export ELECTRON_BUILDER_COMPRESSION_LEVEL="${ELECTRON_BUILDER_COMPRESSION_LEVEL:-5}"

if [[ "${#builder_args[@]}" -gt 0 ]]; then
  exec npx electron-builder --win --x64 "${builder_args[@]}" "$@"
fi

if [[ "${LILY_REQUIRE_WIN_SIGNING:-0}" != "1" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"
  builder_args+=("-c.win.signAndEditExecutable=false")
fi

if [[ "${#builder_args[@]}" -gt 0 ]]; then
  exec npx electron-builder --win --x64 "${builder_args[@]}" "$@"
fi

exec npx electron-builder --win --x64 "$@"
