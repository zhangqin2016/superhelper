#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "deploy/baota/.env is missing. Run ./deploy.sh first."
  exit 1
fi

read_setting() {
  grep "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]'
}

db_mode="$(read_setting DB_MODE)"
gateway_mode="$(read_setting GATEWAY_MODE)"
deploy_mode="$(read_setting DEPLOY_MODE)"
litellm_enabled="$(read_setting LITELLM_ENABLED)"
compose_file=""
compose_profile=""

if [ "$deploy_mode" = "images" ]; then
  if [ "$db_mode" != "external" ]; then
    echo "DEPLOY_MODE=images requires DB_MODE=external."
    exit 1
  fi
  compose_file="docker-compose.images-app-only.yml"
elif [ "$gateway_mode" = "external" ]; then
  if [ "$db_mode" != "external" ]; then
    echo "GATEWAY_MODE=external requires DB_MODE=external."
    exit 1
  fi
  compose_file="docker-compose.app-only.yml"
elif [ "$db_mode" = "external" ]; then
  compose_file="docker-compose.external-postgres.yml"
else
  compose_file="docker-compose.yml"
  compose_profile="--profile bundled"
fi

if docker compose version >/dev/null 2>&1; then
  if [ "$litellm_enabled" = "true" ]; then
    docker compose --env-file .env $compose_profile -f "$compose_file" -f docker-compose.litellm.yml "$@"
  else
    docker compose --env-file .env $compose_profile -f "$compose_file" "$@"
  fi
elif command -v docker-compose >/dev/null 2>&1; then
  if [ "$litellm_enabled" = "true" ]; then
    docker-compose --env-file .env $compose_profile -f "$compose_file" -f docker-compose.litellm.yml "$@"
  else
    docker-compose --env-file .env $compose_profile -f "$compose_file" "$@"
  fi
else
  echo "docker compose is required."
  exit 1
fi
