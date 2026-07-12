#!/usr/bin/env node
// Guards the LILY_FORCE_ACCOUNT escape hatch: on an edition/policy that disables
// the account feature (overseas), the flag must force account + accountLogin ON,
// and its ABSENCE must leave behaviour byte-identical (account stays off). Run in
// child processes so each gets a fresh module load (the client policy is cached
// per load, but the override reads the env at call time).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// A tiny CJS prober: mock electron, force the account-disabling overseas
// edition, then print the resolved account feature from the real module. It
// lives inside the repo so `require("electron")` resolves against node_modules.
const prober = path.join(ROOT, "scripts", ".force-account-probe.cjs");
fs.writeFileSync(prober, `
const os = require("os");
const Module = require("module");
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: (n) => os.tmpdir(), getVersion: () => "0.1.0" },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};
const { getClientPolicy } = require(${JSON.stringify(path.join(ROOT, "src/main/service-client.js"))});
const f = getClientPolicy().features || {};
process.stdout.write(JSON.stringify({ account: f.account, accountLogin: f.accountLogin }));
`);

function probe(env) {
  const out = execFileSync(process.execPath, [prober], {
    env: { ...process.env, LILY_APP_EDITION: "overseas", LILY_SERVICE_API_BASE_URL: "", SERVICE_API_BASE_URL: "", ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

// Baseline: overseas edition disables account, and no flag => stays disabled.
const off = probe({ LILY_FORCE_ACCOUNT: "" });
assert.equal(off.account, false, "overseas edition disables account by default");
assert.equal(off.accountLogin, false, "overseas edition disables login by default");

// Flag on => account + login forced on despite the edition.
for (const val of ["1", "true", "yes"]) {
  const on = probe({ LILY_FORCE_ACCOUNT: val });
  assert.equal(on.account, true, `LILY_FORCE_ACCOUNT=${val} forces account on`);
  assert.equal(on.accountLogin, true, `LILY_FORCE_ACCOUNT=${val} forces login on`);
}

// A junk value must NOT trip the override (byte-identical to off).
const junk = probe({ LILY_FORCE_ACCOUNT: "maybe" });
assert.equal(junk.account, false, "an unrecognized value does not force account on");

try { fs.unlinkSync(prober); } catch { /* noop */ }
console.log("force-account-override: ok");
