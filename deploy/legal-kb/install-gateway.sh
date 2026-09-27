#!/bin/sh
# Install or update the legal retrieval gateway on the corpus host. Idempotent.
#   sh install-gateway.sh <dir holding server.cjs, legal-retrieval.cjs, lily-legal-gateway.service>
set -eu
SRC=${1:?source dir}
BASE=/opt/lily-legal-kb
id lilykb >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$BASE" --shell /usr/sbin/nologin lilykb
install -d -o root -g lilykb -m 0750 "$BASE/gateway"
install -o root -g lilykb -m 0640 "$SRC/server.cjs" "$SRC/legal-retrieval.cjs" "$BASE/gateway/"
# The service reads the corpus and the V2 service's alias table; it never writes them.
chgrp -R lilykb "$BASE/runtime" "$BASE/legal-cn-enterprise-server-V27/service/tools-v2/lib/query"
chmod -R g+rX "$BASE/runtime" "$BASE/legal-cn-enterprise-server-V27/service/tools-v2/lib/query"
chmod g+x "$BASE" "$BASE/legal-cn-enterprise-server-V27" "$BASE/legal-cn-enterprise-server-V27/service" "$BASE/legal-cn-enterprise-server-V27/service/tools-v2" "$BASE/legal-cn-enterprise-server-V27/service/tools-v2/lib"
install -o root -g root -m 0644 "$SRC/lily-legal-gateway.service" /etc/systemd/system/lily-legal-gateway.service
systemctl daemon-reload
systemctl enable lily-legal-gateway.service
systemctl restart lily-legal-gateway.service
for i in $(seq 1 30); do
  if curl -fsS -m 5 http://127.0.0.1:8791/health; then echo; exit 0; fi
  sleep 1
done
journalctl -u lily-legal-gateway -n 40 --no-pager
exit 1
