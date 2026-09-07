#!/bin/sh
set -eu
REDISCLI_AUTH=$(tr -d '\r\n' < /run/secrets/redis_password)
export REDISCLI_AUTH
[ "$(redis-cli --no-auth-warning ping 2>/dev/null)" = PONG ]
