#!/usr/bin/env bash
# 从 upstream 同步 cc-websearch 编译脚本（MIT/GPL，见 resources/skills/cc-websearch-LICENSE）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="/tmp/cc-websearch-vendor-$$"
trap 'rm -rf "$VENDOR"' EXIT

git clone --depth 1 --filter=blob:none --sparse https://github.com/Djarvur/cc-websearch.git "$VENDOR"
(
  cd "$VENDOR"
  git sparse-checkout set skills/websearch/scripts skills/webfetch/scripts LICENSE
)

mkdir -p "$ROOT/resources/skills/websearch/scripts" "$ROOT/resources/skills/webfetch/scripts"
cp "$VENDOR/skills/websearch/scripts/websearch.cjs" "$ROOT/resources/skills/websearch/scripts/"
cp "$VENDOR/skills/webfetch/scripts/webfetch.cjs" "$ROOT/resources/skills/webfetch/scripts/"
cp "$VENDOR/LICENSE" "$ROOT/resources/skills/cc-websearch-LICENSE"
echo "Synced cc-websearch scripts to resources/skills/"
