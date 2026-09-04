#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="${APP_NAME:-lily-workbench}"
REMOTE_DIR="${REMOTE_DIR:-/www/wwwroot/lily-workbench}"
SSH_USER="${SSH_USER:-root}"
SSH_HOST="${SSH_HOST:?SSH_HOST is required, example: SSH_HOST=1.2.3.4}"
SSH_PORT="${SSH_PORT:-22}"
QINIU_BUCKET="${QINIU_BUCKET:-lanrensoft}"
QINIU_DOMAIN="${QINIU_DOMAIN:-https://qny.lanrensoft.cn}"
QINIU_PREFIX="${QINIU_PREFIX:-app/server-deploy}"
STAMP="$(date +%Y%m%d%H%M%S)"
OBJECT_KEY="${QINIU_PREFIX%/}/${APP_NAME}-${STAMP}.tar.gz"
ARCHIVE="/tmp/${APP_NAME}-${STAMP}.tar.gz"
DOWNLOAD_URL="${QINIU_DOMAIN%/}/${OBJECT_KEY}"

cd "$ROOT"

if [ "${SKIP_DEPLOY_PREFLIGHT:-0}" != "1" ]; then
  npm run deploy:preflight
fi

COPYFILE_DISABLE=1 tar \
  --exclude "._*" \
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

node scripts/release-admin.mjs upload \
  --bucket "$QINIU_BUCKET" \
  --key "$OBJECT_KEY" \
  --file "$ARCHIVE"

ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "
  set -eu
  cd /tmp
  curl -fsSL '$DOWNLOAD_URL' -o '${APP_NAME}-deploy.tar.gz'
  mkdir -p '$REMOTE_DIR'
  cd '$REMOTE_DIR'
  if [ -f deploy/baota/.env ]; then
    cp deploy/baota/.env /tmp/${APP_NAME}.env
  fi
  rm -rf server web deploy .dockerignore
  tar -xzf /tmp/${APP_NAME}-deploy.tar.gz
  rm -f /tmp/${APP_NAME}-deploy.tar.gz
  if [ -f /tmp/${APP_NAME}.env ]; then
    mv /tmp/${APP_NAME}.env deploy/baota/.env
  fi
  chmod +x deploy/baota/deploy.sh
  cd deploy/baota
  ./deploy.sh
"

rm -f "$ARCHIVE"
echo "Deployed via Qiniu: $DOWNLOAD_URL"
