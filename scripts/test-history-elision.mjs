#!/usr/bin/env node
// Everything Lily removes from history before a model call goes through one
// contract, and what the content is FOR decides how it may be removed.
//
// The field case (2026-09-18 long-task acceptance): a 15 KB generator script the
// model had written was excerpted to head+tail in history, so the model rewrote
// it from that view — the regenerated middle was internally consistent but the
// supplier names had drifted from the design, and nothing reported an error
// because the write tool had faithfully written what it was given. An excerpt of
// content the model may be asked to REPRODUCE is worse than no excerpt: it reads
// as the whole. [gate: history-elision-contract]
// Run: node scripts/test-history-elision.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "opencode-plugins");
const elision = require(path.join(PLUGINS, "lib", "history-elision.cjs"));

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("a file body is pointed at, never excerpted — the pointer cannot be mistaken for the whole", () => {
  const marker = elision.elideFileBody({ path: "/w/gen_materials.py", bytes: 15234 });
  assert.ok(marker.includes("/w/gen_materials.py"), "it says where the real content is");
  assert.ok(/read .*before editing or rewriting/i.test(marker), "and what to do about it");
  assert.ok(/never copy this text into a file/i.test(marker), "and what not to do");
  assert.ok(marker.includes("14.9 KB"), "and how much was removed, so the model can tell this is not the whole");
  assert.ok(marker.length < 300, `a pointer costs a line, not an excerpt: ${marker.length} chars`);
});

check("the policy is about what content is FOR, not how big it is", () => {
  for (const tool of ["write", "edit", "multiedit", "apply_patch", "patch"]) {
    assert.equal(elision.isReproducible(tool, "content"), true, `${tool} input is a file body`);
    assert.equal(elision.isReproducible(tool, "filePath"), false, "a path is not a body");
  }
  // A tool OUTPUT is referential: the model reasons about it and an excerpt still
  // helps, so excerpting stays allowed there.
  assert.equal(elision.isReproducible("read", "content"), false, "a read result is not something to reproduce");
  assert.equal(elision.isReproducible("", "content"), false);
  assert.equal(elision.isReproducible("write", ""), false);
});

check("recognition is shared, so no marker is invisible to the write backstop", () => {
  const all = [
    elision.elideFileBody({ path: "/a.py", bytes: 10 }),
    elision.elide({ what: "content" }),
    "[lily: this earlier tool call succeeded; its file body is omitted from history because /a.py has since changed on disk.]",
    "[lily: historical snapshot omitted for /a.py]",
    "[lily: content trimmed to fit the model context window]",
    "[lily: large tool output externalized]",
  ];
  for (const marker of all) assert.equal(elision.isElidedBody(marker), true, marker.slice(0, 48));
  assert.equal(elision.LEGACY_PREFIXES.length, 4, "every marker written before this contract is still recognised");
});

check("a real file that merely QUOTES a marker is never refused", () => {
  const script = "# notes\n# the history said [lily: elided the body of x] which is why we re-read\nprint(1)\n";
  assert.equal(elision.isElidedBody(script), false, "quoting a marker is not being one");
  assert.equal(elision.containsElision(script), true, "though it is still detected for idempotence");
  assert.equal(elision.isElidedBody(""), false);
  assert.equal(elision.isElidedBody(null), false);
  assert.equal(elision.isElidedBody("   "), false);
  assert.equal(elision.isElidedBody(`  ${elision.CANONICAL_PREFIX} x]`), true, "leading whitespace does not hide a placeholder");
});

check("the context guard replaces a file body whole and still excerpts everything else", () => {
  const src = fs.readFileSync(path.join(PLUGINS, "context-window-guard.js"), "utf8");
  assert.match(src, /reproducible: elision\.isReproducible\(tool, key\)/, "slots carry what they are for");
  assert.match(src, /slot\.reproducible \? elision\.elideFileBody\(/, "pass 1 points at a file body");
  assert.match(src, /s\.reproducible \? elision\.elideFileBody\(/, "and so does the tightening pass");
  assert.match(src, /: trim\(value, PART_MAX_CHARS\)/, "referential content is still excerpted rather than dropped");
  // The tightening pass halves the cap to a 2000-char floor; a file body cut to
  // that is exactly the shape that misled the model in the field.
  assert.match(src, /Math\.max\(2_000/, "the floor that made this matter is still here for referential slots");
});

check("every producer builds its marker from the contract — no fifth invented sentence", () => {
  const offenders = [];
  for (const file of fs.readdirSync(PLUGINS).filter((name) => name.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(PLUGINS, file), "utf8");
    // A literal "[lily: …]" anywhere outside the contract module means a producer
    // wrote its own marker, which the shared recogniser would not know.
    const literals = src.match(/["'`]\[lily: [^"'`]*/g) || [];
    for (const literal of literals) {
      if (/history-elision/.test(src) && literal.includes("[lily: this earlier tool call succeeded")) continue; // documented legacy prefix
      offenders.push(`${file}: ${literal.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], `markers must come from lib/history-elision.cjs:\n${offenders.join("\n")}`);
});

check("the backstop and the stale-file marker both go through the contract", () => {
  const src = fs.readFileSync(path.join(PLUGINS, "live-file-history-guard.js"), "utf8");
  assert.match(src, /isElidedBody\(String\(value \|\| ""\)\)/, "recognition is shared");
  assert.match(src, /elision\.elideFileBody\(\{ path: file/, "and so is construction");
  assert.match(src, /LILY_LIVE_FILE_MARKER_REJECTED/, "the write backstop still refuses a placeholder body");
});

console.log(`\n${checks} checks passed (history elision contract)`);
