#!/usr/bin/env node
// What a transient network failure looks like is spelled once.
//
// Six modules kept their own list of socket/DNS/timeout codes and phrases; a
// new code from the fetch stack (undici's UND_ERR_* family) had to be added in
// six places to be retried everywhere, and was not. Each site still composes
// its own scope (5xx, "overload") on top of the shared transport signature.
// [gate: transient-network-signature]
// Run: node scripts/test-network-errors.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as net from "../src/shared/network-errors.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("codes, causes, phrases and aborts are one signature", () => {
  assert.equal(net.isTransientNetworkCode("ECONNRESET"), true);
  assert.equal(net.isTransientNetworkCode("und_err_headers_timeout"), true, "case does not matter");
  assert.equal(net.isTransientNetworkCode("EACCES"), false, "a permission error is not the wire failing");
  assert.equal(net.isTransientNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), true, "undici puts the code on the cause");
  assert.equal(net.isTransientNetworkError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(net.isTransientNetworkError("request to https://x timed out"), true);
  assert.equal(net.isTransientNetworkError(new Error("401 Unauthorized")), false);
  assert.equal(net.isTransientNetworkError(null), false);
  assert.match(net.TRANSIENT_NETWORK_SIGNATURE, /ECONNRESET\|/, "a regex fragment sites can compose");
});

check("the classifier that used to spell its own list now inherits a code it never listed", () => {
  const { classifyAssistantError } = require("../src/main/agent-runner.js");
  assert.equal(classifyAssistantError("fetch failed: UND_ERR_HEADERS_TIMEOUT").code, "MODEL_CONNECTION_FAILED");
  assert.equal(classifyAssistantError("connect EHOSTUNREACH 10.0.0.1:443").code, "MODEL_CONNECTION_FAILED");
});

check("no module keeps its own list of transient network codes", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full);
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      const hits = code.match(/\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b/g) || [];
      if (hits.length >= 2) offenders.push(`${rel}: ${[...new Set(hits)].join(",")}`);
    }
  };
  walk(path.join(ROOT, "src/main"));
  walk(path.join(ROOT, "src/renderer"));
  assert.deepEqual(offenders, [], `transient network codes live in src/shared/network-errors.mjs:\n${offenders.join("\n")}`);
});

console.log(`\n${checks} checks passed (network errors)`);
