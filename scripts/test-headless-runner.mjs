#!/usr/bin/env node
// Smoke for the headless/CI runner wiring (no engine spawn, no network):
//  - the bundled engine binary resolves,
//  - the arg guard rejects an empty invocation with the documented exit code.
// The end-to-end run needs a real model gateway + network and is verified by
// actually running scripts/lily-headless.mjs in CI, not here.
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "lily-headless.mjs");

// The bundled engine binary resolves (after `npm run engine:opencode`). The
// binary is a build artifact, not committed — when it hasn't been fetched yet
// (fresh CI checkout, local dev before `npm run engine:opencode`) skip the shape
// check rather than fail; the installer pipeline validates the real bundle via
// verify-runtime-bundle / verify-win-pack.
const { findBundledOpencodeBinary } = require("../src/main/bundle-locator.js");
const bin = findBundledOpencodeBinary();
if (bin) {
  assert.ok(bin.includes("opencode"), `bundled opencode binary path looks wrong: ${bin}`);
} else {
  console.log("headless-runner: bundled opencode binary not fetched — skipping shape check (run `npm run engine:opencode`)");
}

// No prompt and no --command -> usage error, exit 2 (the guard runs before any
// engine/config work, so this needs neither a model nor the binary).
const empty = spawnSync(process.execPath, [script], { encoding: "utf8" });
assert.equal(empty.status, 2, `empty invocation exits 2 (usage), got ${empty.status}`);
assert.match(empty.stderr || "", /usage:/i, "empty invocation prints usage");

console.log("headless-runner: ok");
