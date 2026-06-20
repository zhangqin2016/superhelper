"use strict";

const fs = require("node:fs");

/**
 * Resolve the OpenCode engine binary, in priority order:
 *   1. OPENCODE_BIN (dev override — e.g. scripts/opencode-dev.sh or a prebuilt path)
 *   2. the bundled binary at bundles/<platform>/opencode/bin/opencode (packaged app)
 * Returns null if none found.
 */
function resolveOpencodeCommand() {
  const fromEnv = process.env.OPENCODE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const bundled = require("./bundle-locator").findBundledOpencodeBinary();
  if (bundled) return bundled;
  return null;
}

module.exports = { resolveOpencodeCommand };
