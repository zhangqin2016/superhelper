#!/usr/bin/env node
// A failed turn has one shape, built in one place.
//
// Fourteen sites built the `turn.failed` payload by hand and disagreed: `code`
// at seven, `errorCode` at ten, both at three, `failed: true` missing at one;
// five readers each carried their own `errorCode || code` fallback — and
// `code` is also the process EXIT code on runner payloads, so that fallback
// could turn an exit status into an error code. [gate: turn-failure-shape]
// Run: node scripts/test-turn-failure.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { turnFailure, failureCodeOf, DEFAULT_FAILURE_CODE } = require("../src/main/turn-failure.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("every failure carries the same fields, named the same way", () => {
  assert.deepEqual(turnFailure({ code: "RESUME_INVALID", assistant: "Resend." }),
    { failed: true, assistant: "Resend.", errorCode: "RESUME_INVALID", errorCategory: "", retryable: true });
  const full = turnFailure({ code: "ENGINE_ERROR", category: "runtime", retryable: false, assistant: "x", error: "raw", source: "sse", exitCode: 1 });
  assert.deepEqual(full, { failed: true, assistant: "x", errorCode: "ENGINE_ERROR", errorCategory: "runtime", retryable: false, error: "raw", source: "sse", exitCode: 1 });
  assert.equal(turnFailure({ code: "", assistant: "" }).errorCode, DEFAULT_FAILURE_CODE, "a missing code is still a code");
  assert.equal(turnFailure({ errorCode: "LEGACY" }).errorCode, "LEGACY", "the old field name is accepted, never doubled");
  assert.equal(turnFailure({ code: "X", errorCode: "Y" }).code, undefined, "and never emitted");
  assert.equal(turnFailure({ code: "PUBLIC_HOOK_DENIED", assistant: "" }).failed, true, "a denied turn is a failed turn");
});

check("the one reader understands what was written before, and never mistakes an exit code for an error code", () => {
  assert.equal(failureCodeOf({ errorCode: "A", code: "B" }), "A");
  assert.equal(failureCodeOf({ failureCode: "F" }), "F");
  assert.equal(failureCodeOf({ code: "LEGACY_STRING" }), "LEGACY_STRING", "records written with `code` still read");
  assert.equal(failureCodeOf({ code: 1 }), "", "a numeric exit code is not a failure code");
  assert.equal(failureCodeOf({ code: 0 }), "");
  assert.equal(failureCodeOf(null), "");
});

check("no site builds the payload by hand, and no reader keeps its own fallback", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full);
      if (rel === "src/main/turn-failure.js") continue;
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const m of code.matchAll(/"turn\.failed",\s*\{/g)) offenders.push(`${rel}:${code.slice(0, m.index).split("\n").length}: payload literal`);
      for (const m of code.matchAll(/(?:payload|patch|record)\??\.errorCode\s*\|\|\s*(?:payload|patch|record)\??\.(?:failureCode|code)\b/g)) offenders.push(`${rel}:${code.slice(0, m.index).split("\n").length}: own fallback`);
    }
  };
  walk(path.join(ROOT, "src/main"));
  assert.deepEqual(offenders, [], `failures come from turnFailure() and are read by failureCodeOf():\n${offenders.join("\n")}`);
});

console.log(`\n${checks} checks passed (turn failure shape)`);
