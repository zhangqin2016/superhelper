# Daily database backup → private Qiniu bucket

`db-backup.sh` runs every day on the production host (cron, 03:30):
`pg_dump` of the host PostgreSQL `lily_workbench` → gzip → **encrypted** with
`openssl cms` (AES-256, RSA-4096 recipient) → uploaded to the collaboration
store's **private** bucket under `db-backups/lily_workbench/YYYY/MM/`.

- Qiniu expires each object after 30 days (`deleteAfterDays` in the upload
  token); the token is insert-only, so a backup never overwrites another.
- 7 days are kept locally in `/root/lily-backups/auto/`.
- `status.json` there records every run (stage, size, sha256, Qiniu key).
- The public `lanrensoft` bucket is never used: the script refuses unless the
  bucket is marked private.

## The key

The server holds only the recipient certificate (`recipient.pem`). The private
key is on the operator's machine (`~/.lily-backup-keys/db-backup-private.pem`)
and must be kept somewhere safe offline — without it no backup can be restored,
with it every backup can. A compromised server cannot read past backups.

## Restore

```sh
# 1. fetch the object (private bucket → signed URL from the Qiniu console, or qshell with that bucket's keys)
# 2. decrypt on the machine holding the private key
openssl cms -decrypt -binary -inform DER -inkey ~/.lily-backup-keys/db-backup-private.pem \
  -in lily_workbench-YYYYmmdd-HHMMSS.sql.gz.cms -out lily_workbench.sql.gz
gzip -t lily_workbench.sql.gz
# 3. restore into an EMPTY database first and check it before touching production
createdb lily_restore_check && gunzip -c lily_workbench.sql.gz | psql -d lily_restore_check
```

## Install

```sh
install -d -m 700 /opt/lily-db-backup
install -m 700 db-backup.sh /opt/lily-db-backup/ && install -m 600 qiniu-put.mjs recipient.pem /opt/lily-db-backup/
( crontab -l; echo '30 3 * * * /opt/lily-db-backup/db-backup.sh >> /root/lily-backups/auto/backup.log 2>&1' ) | crontab -
```
