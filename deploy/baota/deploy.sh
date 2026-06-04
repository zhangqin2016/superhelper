#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    db_pass="$(openssl rand -hex 18)"
    admin_token="$(openssl rand -hex 24)"
    session_secret="$(openssl rand -hex 32)"
    sed -i.bak "s/change-this-database-password/${db_pass}/" .env
    sed -i.bak "s/change-this-admin-token/${admin_token}/" .env
    sed -i.bak "s/change-this-session-secret-at-least-32-chars/${session_secret}/" .env
    rm -f .env.bak
    echo "Generated deploy/baota/.env"
    echo "Admin token: ${admin_token}"
  else
    echo "Created .env from .env.example. Edit secrets before continuing."
    exit 1
  fi
fi

db_mode="$(grep '^DB_MODE=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
gateway_mode="$(grep '^GATEWAY_MODE=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"

if [ "$gateway_mode" = "external" ]; then
  compose_file="docker-compose.app-only.yml"
  if [ "$db_mode" != "external" ]; then
    echo "GATEWAY_MODE=external currently expects DB_MODE=external. Set DB_MODE=external and DATABASE_URL in .env."
    exit 1
  fi
else
  compose_file="docker-compose.yml"
  if [ "$db_mode" = "external" ]; then
    compose_file="docker-compose.external-postgres.yml"
  fi
fi

if [ "$db_mode" = "external" ]; then
  if grep -q '^DATABASE_URL=postgres://user:password@host:5432/lily_workbench' .env; then
    echo "DB_MODE=external, but DATABASE_URL still uses the example value. Edit deploy/baota/.env first."
    exit 1
  fi
fi

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env -f "$compose_file" up -d --build
else
  docker-compose --env-file .env -f "$compose_file" up -d --build
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for post-deploy health check."
  exit 1
fi

admin_token="$(grep '^ADMIN_TOKEN=' .env 2>/dev/null | cut -d= -f2-)"
if [ -z "$admin_token" ]; then
  echo "ADMIN_TOKEN is missing; cannot run admin health check."
  exit 1
fi

if [ "${gateway_mode:-bundled}" = "external" ]; then
  api_base="http://127.0.0.1:$(grep '^API_PORT=' .env | cut -d= -f2)"
else
  api_base="http://127.0.0.1:$(grep '^HTTP_PORT=' .env | cut -d= -f2)"
fi

health_ok=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  health_json="$(curl -fsS -H "Authorization: Bearer ${admin_token}" "${api_base}/api/admin/health" 2>/dev/null || true)"
  if printf '%s' "$health_json" | grep -q '"ok":true'; then
    health_ok="1"
    break
  fi
  sleep 3
done

if [ -z "$health_ok" ]; then
  echo "Admin health check failed. Check containers and /api/admin/health."
  if [ -n "${health_json:-}" ]; then
    printf '%s\n' "$health_json"
  fi
  exit 1
fi

echo "Lily Workbench is starting."
echo "Database mode: ${db_mode:-internal}"
echo "Gateway mode: ${gateway_mode:-bundled}"
if [ "${gateway_mode:-bundled}" = "external" ]; then
  echo "API local port: http://127.0.0.1:$(grep '^API_PORT=' .env | cut -d= -f2)"
  echo "Web local port: http://127.0.0.1:$(grep '^WEB_PORT=' .env | cut -d= -f2)"
else
  echo "Local gateway: http://127.0.0.1:$(grep '^HTTP_PORT=' .env | cut -d= -f2)"
fi
echo "Admin page: /admin"
