#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "deploy/baota/push-to-server.sh is deprecated."
echo "Using the standard Qiniu relay deployment flow instead."
exec "$SCRIPT_DIR/push-via-qiniu.sh" "$@"
