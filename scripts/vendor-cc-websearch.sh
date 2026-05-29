#!/usr/bin/env bash
# 从 upstream 同步 cc-websearch 的 webfetch 脚本（MIT/GPL，见 resources/skills/cc-websearch-LICENSE）
# websearch 已改为内置 SearXNG 实现，不再从 upstream 覆盖。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="/tmp/cc-websearch-vendor-$$"
trap 'rm -rf "$VENDOR"' EXIT

git clone --depth 1 --filter=blob:none --sparse https://github.com/Djarvur/cc-websearch.git "$VENDOR"
(
  cd "$VENDOR"
  git sparse-checkout set skills/webfetch/scripts LICENSE
)

mkdir -p "$ROOT/resources/skills/webfetch/scripts"
cp "$VENDOR/skills/webfetch/scripts/webfetch.cjs" "$ROOT/resources/skills/webfetch/scripts/"
cp "$VENDOR/LICENSE" "$ROOT/resources/skills/cc-websearch-LICENSE"
echo "Synced cc-webfetch script to resources/skills/webfetch/"
