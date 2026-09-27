#!/bin/sh
# Apply a reviewed V27 data delta into the managed runtime, at the lowest CPU/IO
# priority so the API and database on this host keep their share. The original
# pack is only read; the new release is built beside the old one and the active
# pointer moves only after verify. Rollback: legal-pack-delta.py rollback.
#   sh apply-delta.sh <patch dir> <delta dir name> <new release id> <expected active release> <confirm sha256>
set -eu
PATCH=${1:?patch dir}; DELTA=${2:?delta dir}; RELEASE=${3:?release id}; EXPECTED=${4:?expected release}; CONFIRM=${5:?confirm sha256}
BASE=/opt/lily-legal-kb
RUNTIME=$BASE/runtime
T="$PATCH/tools/v2/legal-pack-delta.py"
run() { nice -n 19 ionice -c3 python3 "$T" "$@"; }
if [ ! -e "$RUNTIME/active.json" ]; then
  echo "== init $(date -Is)"
  run init --db "$BASE/legal-cn-enterprise-server-V27/pack/legal.sqlite" --runtime "$RUNTIME" --release "$EXPECTED"
fi
echo "== apply $(date -Is)"
run apply --runtime "$RUNTIME" --delta "$PATCH/data/$DELTA" --release "$RELEASE" --expected "$EXPECTED" --confirm "$CONFIRM"
echo "== verify $(date -Is)"
run verify --runtime "$RUNTIME"
echo "== done $(date -Is)"
