#!/usr/bin/env bash
# Install the upstream Claude Code CLI for a macOS arch and copy its native
# binary to bundles/<platform>/engine-upstream. The runner arch must match the
# target (arm64 runner → darwin-arm64, x64 runner → darwin-x64).
#
#   fetch-mac-engine.sh <darwin-arm64|darwin-x64> [claude_version]
set -euo pipefail

PLATFORM="${1:?usage: fetch-mac-engine.sh <darwin-arm64|darwin-x64> [version]}"
VERSION="${2:-}"

case "$PLATFORM" in
  darwin-arm64) PKG="@anthropic-ai/claude-code-darwin-arm64" ;;
  darwin-x64)   PKG="@anthropic-ai/claude-code-darwin-x64" ;;
  *) echo "unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

if [ -n "$VERSION" ]; then
  npm install -g "@anthropic-ai/claude-code@$VERSION" --include=optional
  npm install -g "$PKG@$VERSION"
else
  npm install -g @anthropic-ai/claude-code --include=optional
  npm install -g "$PKG"
fi

GLOBAL_MODULES="$(npm root -g)"
node "$GLOBAL_MODULES/@anthropic-ai/claude-code/install.cjs"

# Locate the native `claude` binary inside the platform package.
SOURCE=""
for cand in \
  "$GLOBAL_MODULES/$PKG/claude" \
  "$GLOBAL_MODULES/@anthropic-ai/claude-code/node_modules/$PKG/claude"; do
  if [ -f "$cand" ]; then SOURCE="$cand"; break; fi
done
if [ -z "$SOURCE" ]; then
  SOURCE="$(find "$GLOBAL_MODULES" -type f -name claude -path "*${PKG#@anthropic-ai/}*" 2>/dev/null | head -n1 || true)"
fi
if [ -z "$SOURCE" ]; then
  echo "Could not locate $PKG/claude under $GLOBAL_MODULES" >&2
  exit 1
fi

DEST_DIR="bundles/$PLATFORM"
mkdir -p "$DEST_DIR"
cp -f "$SOURCE" "$DEST_DIR/engine-upstream"
chmod +x "$DEST_DIR/engine-upstream"
"$DEST_DIR/engine-upstream" --version
echo "[fetch-mac-engine] ok — $DEST_DIR/engine-upstream"
