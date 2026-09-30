#!/usr/bin/env sh
# Zero-downtime API deploy: start the idle colour with the new image, prove it
# healthy, point port 13000 at it (api-port.sh), then let the old release
# finish its open requests before it stops.
#
#   API_IMAGE_TAG=<tag> ./deploy-api-bluegreen.sh
#
# Colours: blue 13010, green 13011. The first run finds the pre-colour
# container (lily-api, listening on 13000 itself) and retires it the same way.
# Any failure before the switch leaves the current release serving untouched.
set -eu

cd "$(dirname "$0")"
TAG="${API_IMAGE_TAG:?API_IMAGE_TAG is required}"
STATE_FILE="${LILY_API_STATE_FILE:-/www/wwwroot/lily-workbench/.lily-api-active}"
# Long enough for any answer in flight to finish; WebSocket clients (collaboration,
# mobile relay) never close by themselves and reconnect to the new release when stopped.
DRAIN_MAX_SECONDS="${DRAIN_MAX_SECONDS:-300}"
HEALTH_MAX_SECONDS="${HEALTH_MAX_SECONDS:-180}"
PUBLIC_PORT=13000
UNIT_DIR="${LILY_API_UNIT_DIR:-/etc/systemd/system}"
# The public entrances that must reach the new colour before the old one retires.
LILY_API_PUBLIC_URLS="${LILY_API_PUBLIC_URLS-https://lilych.lilywb.cn https://lilyxinjiapo.lilywb.cn}"

log() { printf '[bluegreen %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -f .env ] || fail "deploy/baota/.env is missing"
docker image inspect "lily-workbench-api:$TAG" >/dev/null 2>&1 || fail "image lily-workbench-api:$TAG is not loaded"
admin_token="$(grep '^ADMIN_TOKEN=' .env | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
[ -n "$admin_token" ] || fail "ADMIN_TOKEN is missing in .env"

port_of() { [ "$1" = blue ] && echo 13010 || echo 13011; }
active_port="$(cat "$STATE_FILE" 2>/dev/null || true)"
case "$active_port" in
  13010) old_color=blue ;;
  13011) old_color=green ;;
  *)
    if docker inspect lily-api >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' lily-api)" = true ]; then
      old_color=legacy
    else
      old_color=none
    fi
    ;;
esac
if [ "$old_color" = blue ]; then new_color=green; else new_color=blue; fi
new_port="$(port_of "$new_color")"
case "$old_color" in
  blue|green) old_port="$(port_of "$old_color")"; old_container="lily-api-$old_color" ;;
  legacy) old_port=$PUBLIC_PORT; old_container=lily-api ;;
  none) old_port=""; old_container="" ;;
esac
log "active=$old_color${old_port:+ ($old_port)} -> new=$new_color ($new_port), image lily-workbench-api:$TAG"

# 1. Start the idle colour. A leftover container of that colour is replaced; it serves nothing.
if docker inspect "lily-api-$new_color" >/dev/null 2>&1; then
  log "removing idle leftover lily-api-$new_color"
  docker rm -f "lily-api-$new_color" >/dev/null
fi
API_COLOR="$new_color" API_COLOR_PORT="$new_port" API_IMAGE_TAG="$TAG" \
  docker compose --env-file .env -p "lily-api-$new_color" -f docker-compose.api-color.yml up -d --force-recreate

# 2. Healthy on its own port, including the authenticated admin health.
waited=0
until curl -fsS "http://127.0.0.1:$new_port/health" >/dev/null 2>&1 \
  && curl -fsS -H "Authorization: Bearer $admin_token" "http://127.0.0.1:$new_port/api/admin/health" 2>/dev/null | grep -q '"ok":true'; do
  if [ "$waited" -ge "$HEALTH_MAX_SECONDS" ]; then
    docker logs --tail 40 "lily-api-$new_color" 2>&1 | sed 's/^/  | /'
    docker rm -f "lily-api-$new_color" >/dev/null 2>&1 || true
    fail "lily-api-$new_color never became healthy; the current release keeps serving, nothing was switched"
  fi
  sleep 3; waited=$((waited + 3))
done
log "lily-api-$new_color healthy after ${waited}s"

# 3. Boot persistence of the redirect (installed once; restores the recorded port).
if [ ! -f "$UNIT_DIR/lily-api-port.service" ]; then
  cat > "$UNIT_DIR/lily-api-port.service" <<UNIT
[Unit]
Description=Lily API public port 13000 -> active colour (api-port.sh)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh $(pwd)/api-port.sh restore
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable lily-api-port.service >/dev/null 2>&1
  log "installed lily-api-port.service (restores the redirect at boot)"
fi

# 4. Switch: new connections to 13000 go to the new colour from here on.
sh ./api-port.sh set "$new_port"
# Verified by WHO answers, on every path that reaches 13000: locally (the host
# nginx's path) and through each public domain (the overseas edge arrives from
# outside, on the kernel's other path). "ok" alone could come from the old one.
answered_by_new() {
  curl -fsS -m 10 -H "Authorization: Bearer $admin_token" "$1/api/admin/health" 2>/dev/null \
    | grep -q "\"apiColor\":\"$new_color\""
}
verified=""
for _ in 1 2 3 4 5; do
  verified=1
  for base in "http://127.0.0.1:$PUBLIC_PORT" ${LILY_API_PUBLIC_URLS:-}; do
    if ! answered_by_new "$base"; then verified=""; log "not yet answered by lily-api-$new_color: $base"; fi
  done
  [ -n "$verified" ] && break
  sleep 2
done
if [ -z "$verified" ]; then
  if [ -n "$old_port" ] && [ "$old_color" != legacy ]; then sh ./api-port.sh set "$old_port"; fi
  if [ "$old_color" = legacy ]; then iptables -t nat -F LILY_API_PORT; rm -f "$STATE_FILE"; fi
  fail "port $PUBLIC_PORT does not reach lily-api-$new_color; switched back to $old_color"
fi
log "port $PUBLIC_PORT now serves lily-api-$new_color"

# 5. The old release finishes what it started, then stops.
if [ -n "$old_container" ]; then
  waited=0
  while :; do
    open="$(ss -Htn state established "( sport = :$old_port )" 2>/dev/null | wc -l | tr -d ' ')"
    [ "$open" -eq 0 ] && break
    if [ "$waited" -ge "$DRAIN_MAX_SECONDS" ]; then
      log "old release still has $open open connection(s) after ${waited}s; stopping it with its drain grace"
      break
    fi
    [ $((waited % 30)) -eq 0 ] && log "waiting for $open open connection(s) on $old_container to finish"
    sleep 5; waited=$((waited + 5))
  done
  docker stop -t 120 "$old_container" >/dev/null
  if [ "$old_color" = legacy ]; then
    log "$old_container stopped (kept for rollback: docker start $old_container && iptables -t nat -F LILY_API_PORT && rm -f $STATE_FILE)"
  else
    log "$old_container stopped (kept for rollback: docker start $old_container && sh ./api-port.sh set $old_port)"
  fi
fi
log "done: lily-api-$new_color on $new_port serves $PUBLIC_PORT (image $TAG)"
