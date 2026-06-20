#!/bin/sh
# Dev shim: run the VENDORED opencode source (matches what we build against)
# instead of any globally-installed opencode binary. Lets OpencodeServerManager
# spawn it as a normal `<bin> serve ...` command.
#
#   OPENCODE_BIN=scripts/opencode-dev.sh node scripts/smoke-opencode.mjs "hi"
exec bun run --cwd "$(dirname "$0")/../opencode/packages/opencode" src/index.ts "$@"
