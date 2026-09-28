#!/bin/sh
# Daily Lily database backup: pg_dump → gzip → encrypt to an offline key →
# private Qiniu bucket (expires after QINIU_DELETE_AFTER_DAYS) + local copies.
#
# The bucket and its keys are the collaboration store's private bucket from the
# deploy .env; the dump is encrypted with `openssl cms` to a recipient
# certificate whose private key is NOT on this host, so neither a leaked bucket
# nor a compromised server exposes past backups. Every run writes status.json;
# a failure exits non-zero and leaves no partial file behind.
set -eu
umask 077

ENV_FILE=${LILY_ENV_FILE:-/www/wwwroot/lily-workbench/deploy/baota/.env}
HERE=$(cd "$(dirname "$0")" && pwd)
RECIPIENT=${LILY_BACKUP_RECIPIENT:-$HERE/recipient.pem}
LOCAL_DIR=${LILY_BACKUP_DIR:-/root/lily-backups/auto}
LOCAL_KEEP_DAYS=${LILY_BACKUP_LOCAL_KEEP_DAYS:-7}
QINIU_DELETE_AFTER_DAYS=${LILY_BACKUP_QINIU_KEEP_DAYS:-30}
PREFIX=${LILY_BACKUP_PREFIX:-db-backups/lily_workbench}
STATUS=$LOCAL_DIR/status.json

envval() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
status() { printf '{"at":"%s","ok":%s,"stage":"%s","file":"%s","bytes":%s,"sha256":"%s","key":"%s","detail":"%s"}\n' \
  "$(date -Is)" "$1" "$2" "${OUT:-}" "${BYTES:-0}" "${SUM:-}" "${KEY:-}" "$3" > "$STATUS"; }
fail() { status false "$STAGE" "$1"; echo "[db-backup] FAILED at $STAGE: $1" >&2; rm -f "${TMP:-/nonexistent}"*; exit 1; }

mkdir -p "$LOCAL_DIR"
STAGE=config
DATABASE_URL=$(envval DATABASE_URL); BUCKET=$(envval COLLAB_QINIU_BUCKET)
QINIU_ACCESS_KEY=$(envval COLLAB_QINIU_ACCESS_KEY); QINIU_SECRET_KEY=$(envval COLLAB_QINIU_SECRET_KEY)
[ "$(envval COLLAB_QINIU_PRIVATE_BUCKET)" = "true" ] || fail "the collaboration bucket is not marked private; refusing to upload a database there"
[ -n "$DATABASE_URL" ] && [ -n "$BUCKET" ] && [ -n "$QINIU_ACCESS_KEY" ] && [ -n "$QINIU_SECRET_KEY" ] || fail "DATABASE_URL or COLLAB_QINIU_* missing in $ENV_FILE"
[ -f "$RECIPIENT" ] || fail "recipient certificate missing: $RECIPIENT"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT=$LOCAL_DIR/lily_workbench-$STAMP.sql.gz.cms
TMP=$LOCAL_DIR/.partial-$STAMP

STAGE=dump
# pg_dump compresses itself so its own exit status is the one checked (a pipe
# into gzip would report gzip's).
pg_dump --no-owner --no-privileges --compress=9 --file="$TMP.sql.gz" "$DATABASE_URL" || fail "pg_dump failed"
gzip -t "$TMP.sql.gz" || fail "gzip check failed"
LINES=$(gzip -dc "$TMP.sql.gz" | grep -c "^CREATE TABLE" || true)
[ "$LINES" -gt 10 ] || fail "dump holds only $LINES tables"

STAGE=encrypt
openssl cms -encrypt -binary -aes256 -outform DER -in "$TMP.sql.gz" -out "$TMP.cms" "$RECIPIENT" || fail "encryption failed"
rm -f "$TMP.sql.gz"
mv "$TMP.cms" "$OUT"
BYTES=$(wc -c < "$OUT" | tr -d ' ')
SUM=$(sha256sum "$OUT" | cut -c1-64)

STAGE=upload
KEY="$PREFIX/$(date +%Y/%m)/lily_workbench-$STAMP.sql.gz.cms"
QINIU_ACCESS_KEY="$QINIU_ACCESS_KEY" QINIU_SECRET_KEY="$QINIU_SECRET_KEY" \
  node "$HERE/qiniu-put.mjs" --bucket "$BUCKET" --key "$KEY" --file "$OUT" --delete-after-days "$QINIU_DELETE_AFTER_DAYS" \
  > "$LOCAL_DIR/.upload-$STAMP.json" || fail "upload to $BUCKET failed"
rm -f "$LOCAL_DIR/.upload-$STAMP.json"

STAGE=retention
find "$LOCAL_DIR" -maxdepth 1 -name 'lily_workbench-*.sql.gz.cms' -mtime +"$LOCAL_KEEP_DAYS" -delete || true

status true done "$LINES tables; kept locally $LOCAL_KEEP_DAYS days, in Qiniu $QINIU_DELETE_AFTER_DAYS days"
echo "[db-backup] ok $OUT ($BYTES bytes, $LINES tables) -> $BUCKET/$KEY"
