#!/bin/sh
set -eu
# Generate a private config at runtime; never expose the password in argv/logs.
redis_secret=$(tr -d '\r\n' < /run/secrets/redis_password)
case "$redis_secret" in *[!a-fA-F0-9]*|'') echo 'Invalid Redis secret format' >&2; exit 1;; esac
[ "${#redis_secret}" -eq 64 ] || { echo 'Redis secret must contain 64 hex characters' >&2; exit 1; }
redis_config_dir=$(mktemp -d /tmp/lily-redis.XXXXXX)
chmod 700 "$redis_config_dir"
{
  printf '%s\n' 'bind 0.0.0.0' 'protected-mode yes' 'port 6379'
  printf 'requirepass %s\n' "$redis_secret"
  printf '%s\n' 'maxmemory 128mb' 'maxmemory-policy noeviction' 'save ""' 'appendonly no' 'loglevel notice'
} > "$redis_config_dir/redis.conf"
unset redis_secret
chmod 600 "$redis_config_dir/redis.conf"
chown -R redis:redis "$redis_config_dir"
exec /usr/local/bin/docker-entrypoint.sh redis-server "$redis_config_dir/redis.conf"
