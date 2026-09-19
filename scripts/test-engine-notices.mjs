#!/usr/bin/env node
// A notice's phase semantics belong to its code and are declared once.
//
// Twenty-eight sites in eighteen modules built `{ code, level, panel, replace,
// replacesCode, done, detail }` by hand; `detail` was missing at eight of them
// (the vision "skipped" chip carried no reason for eleven days), and the
// renderer kept a second copy of the visibility policy "to be kept in sync".
// src/shared/engine-notices.mjs is the catalogue; a site names the code and
// what is specific to the moment; both processes read one policy.
// [gate: engine-notice-catalogue]
// Run: node scripts/test-engine-notices.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as shared from "../src/shared/engine-notices.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { engineNotice, NOTICE_CODES } = shared;

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("a site says the code and the moment; the catalogue supplies the phase", () => {
  assert.deepEqual(engineNotice("visionSkipped", { detail: "why" }),
    { code: "visionSkipped", level: "warning", panel: true, replace: true, replacesCode: "visionPreparing", done: true, detail: "why" });
  assert.deepEqual(engineNotice("longWait"), { code: "longWait", level: "progress", panel: true, replace: true, replacesCode: "longWait" });
  assert.deepEqual(engineNotice("workProgress", { replaces: "documentPreparing", detail: "1/3", progress: { total: 3 } }),
    { code: "workProgress", level: "progress", panel: true, replace: true, replacesCode: "documentPreparing", detail: "1/3", progress: { total: 3 } });
  // A code that reports both progress and failure says which, this once.
  assert.equal(engineNotice("parentTaskClosureRecovery", { level: "warning" }).level, "warning");
  // Legacy field name still accepted, so no caller can half-migrate.
  assert.equal(engineNotice("subagentEngineError", { replacesCode: "subagentEngineError:x" }).replacesCode, "subagentEngineError:x");
  assert.equal(engineNotice("subagentEngineError").panel, undefined, "a code with no panel opinion adds none");
  assert.deepEqual(engineNotice("unlisted-code"), { code: "unlisted-code", level: "info" }, "an unknown code is a plain line, never a crash");
});

check("the preflight phases end the line they began, and the two preparing phases behave alike", () => {
  for (const [begin, ends] of [["visionPreparing", ["visionReady", "visionSkipped"]], ["documentPreparing", ["documentReady", "documentSkipped"]]]) {
    assert.equal(shared.noticeVisibleInPanel(engineNotice(begin, { detail: "…" })), true, `${begin} is a live panel line`);
    for (const end of ends) {
      const n = engineNotice(end, { detail: "…" });
      assert.equal(n.replacesCode, begin); assert.equal(n.done, true);
    }
  }
});

check("one visibility policy, read by both processes", () => {
  const main = require("../src/main/engine-notice-policy.js");
  assert.equal(main.noticeVisibleInPanel, shared.noticeVisibleInPanel, "the main process re-exports the shared policy");
  const renderer = fs.readFileSync(path.join(ROOT, "src/renderer/modules/engine-notice-policy.js"), "utf8");
  assert.match(renderer, /from "\.\.\/\.\.\/shared\/engine-notices\.mjs"/, "and so does the renderer");
  assert.ok(!/new Set\(\[/.test(renderer), "with no list of its own");
  assert.equal(shared.noticeVisibleInPanel(engineNotice("thinkingProgress")), false);
  assert.equal(shared.noticeVisibleInPanel(engineNotice("engineRetry", { detail: "x" })), false, "progress lines outside the live set stay out of the panel");
  assert.equal(shared.noticeVisibleInPanel(engineNotice("upstreamAuthFailed", { detail: "x" })), true);
});

check("every notice the app emits is in the catalogue, and none is built by hand", () => {
  const offenders = []; const unknown = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full);
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const m of code.matchAll(/\{[^{}]*\bcode:\s*"[A-Za-z]+"[^{}]*\blevel:\s*"(?:progress|warning|info|error)"[^{}]*\}/g)) {
        offenders.push(`${rel}:${code.slice(0, m.index).split("\n").length}`);
      }
      for (const m of code.matchAll(/engineNotice\(\s*"([A-Za-z]+)"/g)) if (!NOTICE_CODES[m[1]]) unknown.add(`${rel}: ${m[1]}`);
    }
  };
  walk(path.join(ROOT, "src/main"));
  walk(path.join(ROOT, "src/renderer"));
  assert.deepEqual(offenders, [], `notices are built by engineNotice(code, …):\n${offenders.join("\n")}`);
  assert.deepEqual([...unknown], [], `codes must be catalogued:\n${[...unknown].join("\n")}`);
});

console.log(`\n${checks} checks passed (engine notices)`);
