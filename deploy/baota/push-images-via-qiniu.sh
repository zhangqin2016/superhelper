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
QINIU_PREFIX="${QINIU_PREFIX:-app/server-images}"
PLATFORM="${PLATFORM:-linux/amd64}"
IMAGE_TAG="${IMAGE_TAG:-$(cd "$ROOT" && git rev-parse --short HEAD)}"
STAMP="$(date +%Y%m%d%H%M%S)"
WORK_DIR="${TMPDIR:-/tmp}/${APP_NAME}-images-${STAMP}"

API_IMAGE="lily-workbench-api:${IMAGE_TAG}"
WEB_IMAGE="lily-workbench-web:${IMAGE_TAG}"
API_TAR="${WORK_DIR}/api-image.tar"
WEB_TAR="${WORK_DIR}/web-image.tar"
API_GZ="${API_TAR}.gz"
WEB_GZ="${WEB_TAR}.gz"
DEPLOY_ARCHIVE="${WORK_DIR}/deploy-baota.tar.gz"

API_KEY="${QINIU_PREFIX%/}/${IMAGE_TAG}/${APP_NAME}-api-${STAMP}.tar.gz"
WEB_KEY="${QINIU_PREFIX%/}/${IMAGE_TAG}/${APP_NAME}-web-${STAMP}.tar.gz"
DEPLOY_KEY="${QINIU_PREFIX%/}/${IMAGE_TAG}/${APP_NAME}-deploy-baota-${STAMP}.tar.gz"
API_URL="${QINIU_DOMAIN%/}/${API_KEY}"
WEB_URL="${QINIU_DOMAIN%/}/${WEB_KEY}"
DEPLOY_URL="${QINIU_DOMAIN%/}/${DEPLOY_KEY}"

mkdir -p "$WORK_DIR"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$ROOT"

if [ "${SKIP_DEPLOY_PREFLIGHT:-0}" != "1" ]; then
  npm run deploy:preflight
fi

echo "Building ${API_IMAGE} for ${PLATFORM}"
docker buildx build \
  --platform "$PLATFORM" \
  -t "$API_IMAGE" \
  -f server/Dockerfile \
  --output "type=docker,dest=${API_TAR}" \
  .
gzip -f "$API_TAR"

echo "Building ${WEB_IMAGE} for ${PLATFORM}"
docker buildx build \
  --platform "$PLATFORM" \
  -t "$WEB_IMAGE" \
  -f web/Dockerfile \
  --output "type=docker,dest=${WEB_TAR}" \
  .
gzip -f "$WEB_TAR"

tar \
  --exclude ".DS_Store" \
  --exclude "deploy/baota/.env" \
  -czf "$DEPLOY_ARCHIVE" \
  deploy/baota

node scripts/release-admin.mjs upload --bucket "$QINIU_BUCKET" --key "$API_KEY" --file "$API_GZ"
node scripts/release-admin.mjs upload --bucket "$QINIU_BUCKET" --key "$WEB_KEY" --file "$WEB_GZ"
node scripts/release-admin.mjs upload --bucket "$QINIU_BUCKET" --key "$DEPLOY_KEY" --file "$DEPLOY_ARCHIVE"

ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "
  set -eu
  cd /tmp
  curl -fsSL '$API_URL' -o '${APP_NAME}-api-image.tar.gz'
  curl -fsSL '$WEB_URL' -o '${APP_NAME}-web-image.tar.gz'
  curl -fsSL '$DEPLOY_URL' -o '${APP_NAME}-deploy-baota.tar.gz'
  gzip -dc '${APP_NAME}-api-image.tar.gz' | docker load
  gzip -dc '${APP_NAME}-web-image.tar.gz' | docker load
  mkdir -p '$REMOTE_DIR'
  cd '$REMOTE_DIR'
  if [ -f deploy/baota/.env ]; then
    cp deploy/baota/.env /tmp/${APP_NAME}.env
  fi
  rm -rf deploy
  tar -xzf /tmp/${APP_NAME}-deploy-baota.tar.gz
  if [ -f /tmp/${APP_NAME}.env ]; then
    mv /tmp/${APP_NAME}.env deploy/baota/.env
  fi
  set_env() {
    key=\"\$1\"
    value=\"\$2\"
    if grep -q \"^\${key}=\" deploy/baota/.env; then
      sed -i \"s|^\${key}=.*|\${key}=\${value}|\" deploy/baota/.env
    else
      printf '%s=%s\n' \"\$key\" \"\$value\" >> deploy/baota/.env
    fi
  }
  set_env DEPLOY_MODE images
  set_env IMAGE_TAG '$IMAGE_TAG'
  chmod +x deploy/baota/deploy.sh
  cd deploy/baota
  ./deploy.sh
  rm -f /tmp/${APP_NAME}-api-image.tar.gz /tmp/${APP_NAME}-web-image.tar.gz /tmp/${APP_NAME}-deploy-baota.tar.gz
"

echo "Deployed image tag ${IMAGE_TAG} via Qiniu:"
echo "  ${API_URL}"
echo "  ${WEB_URL}"
