#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="${APP_NAME:-lily-workbench}"
REMOTE_DIR="${REMOTE_DIR:-/www/wwwroot/lily-workbench}"
SSH_USER="${SSH_USER:-root}"
SSH_HOST="${SSH_HOST:?SSH_HOST is required, example: SSH_HOST=1.2.3.4}"
SSH_PORT="${SSH_PORT:-22}"
ARCHIVE="/tmp/${APP_NAME}-deploy.tar.gz"

cd "$ROOT"

tar \
  --exclude ".DS_Store" \
  --exclude "server/.env" \
  --exclude "server/node_modules" \
  --exclude "web/.env" \
  --exclude "web/node_modules" \
  --exclude "web/.next" \
  -czf "$ARCHIVE" \
  .dockerignore \
  server \
  web \
  deploy/baota

ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "mkdir -p '$REMOTE_DIR'"
scp -P "$SSH_PORT" "$ARCHIVE" "$SSH_USER@$SSH_HOST:$REMOTE_DIR/${APP_NAME}-deploy.tar.gz"
ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "
  set -eu
  cd '$REMOTE_DIR'
  if [ -f deploy/baota/.env ]; then
    cp deploy/baota/.env /tmp/${APP_NAME}.env
  fi
  rm -rf server web deploy .dockerignore
  tar -xzf '${APP_NAME}-deploy.tar.gz'
  rm -f '${APP_NAME}-deploy.tar.gz'
  if [ -f /tmp/${APP_NAME}.env ]; then
    mv /tmp/${APP_NAME}.env deploy/baota/.env
  fi
  chmod +x deploy/baota/deploy.sh
  cd deploy/baota
  ./deploy.sh
"

rm -f "$ARCHIVE"
echo "Deployed to $SSH_USER@$SSH_HOST:$REMOTE_DIR"
