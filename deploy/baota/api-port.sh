#!/usr/bin/env sh
# Point the public API port (13000) at the active API colour, in the kernel.
#
# Every connection to 13000 — the host nginx (127.0.0.1) and the overseas edge
# (external) — is redirected to the active colour's port. Changing the target
# affects NEW connections only; established ones (an answer still streaming)
# stay on the release they started on until they end. Nothing else changes:
# the peer address, the headers and the nginx configuration are as before.
#
#   api-port.sh set <port>    redirect 13000 to <port> and record it
#   api-port.sh restore       re-apply the recorded port (boot: lily-api-port.service)
#   api-port.sh show          print the recorded port and the live rules
set -eu

PUBLIC_PORT="${LILY_API_PUBLIC_PORT:-13000}"
STATE_FILE="${LILY_API_STATE_FILE:-/www/wwwroot/lily-workbench/.lily-api-active}"
CHAIN="LILY_API_PORT"

ensure_chain() {
  iptables -t nat -N "$CHAIN" 2>/dev/null || true
  iptables -t nat -C PREROUTING -p tcp --dport "$PUBLIC_PORT" -j "$CHAIN" 2>/dev/null \
    || iptables -t nat -I PREROUTING 1 -p tcp --dport "$PUBLIC_PORT" -j "$CHAIN"
  iptables -t nat -C OUTPUT -o lo -p tcp --dport "$PUBLIC_PORT" -j "$CHAIN" 2>/dev/null \
    || iptables -t nat -I OUTPUT 1 -o lo -p tcp --dport "$PUBLIC_PORT" -j "$CHAIN"
}

point_to() {
  target="$1"
  ensure_chain
  # New target first, then drop every other rule: at no moment does 13000 point nowhere.
  iptables -t nat -I "$CHAIN" 1 -p tcp --dport "$PUBLIC_PORT" -j REDIRECT --to-ports "$target"
  while iptables -t nat -S "$CHAIN" | grep -- "-j REDIRECT" | grep -v -- "--to-ports $target\$" | head -n 1 | grep -q .; do
    rule="$(iptables -t nat -S "$CHAIN" | grep -- "-j REDIRECT" | grep -v -- "--to-ports $target\$" | head -n 1 | sed 's/^-A /-D /')"
    # shellcheck disable=SC2086
    iptables -t nat $rule
  done
  while [ "$(iptables -t nat -S "$CHAIN" | grep -c -- "--to-ports $target\$")" -gt 1 ]; do
    iptables -t nat -D "$CHAIN" -p tcp --dport "$PUBLIC_PORT" -j REDIRECT --to-ports "$target"
  done
}

case "${1:-}" in
  set)
    port="${2:?usage: api-port.sh set <port>}"
    case "$port" in ''|*[!0-9]*) echo "api-port: not a port: $port" >&2; exit 2 ;; esac
    point_to "$port"
    printf '%s\n' "$port" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
    echo "api-port: $PUBLIC_PORT -> $port"
    ;;
  restore)
    if [ ! -s "$STATE_FILE" ]; then
      echo "api-port: no recorded port ($STATE_FILE); nothing to restore"
      exit 0
    fi
    point_to "$(cat "$STATE_FILE")"
    echo "api-port: restored $PUBLIC_PORT -> $(cat "$STATE_FILE")"
    ;;
  show)
    echo "recorded: $(cat "$STATE_FILE" 2>/dev/null || echo none)"
    iptables -t nat -S "$CHAIN" 2>/dev/null || echo "no $CHAIN chain"
    ;;
  *)
    echo "usage: api-port.sh set <port> | restore | show" >&2
    exit 2
    ;;
esac
