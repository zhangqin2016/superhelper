#!/usr/bin/env node
/**
 * A file tool's result is capped by BYTES, not only by lines.
 *
 * Acceptance 2026-09-17 DEF-07: a 2-line, 60 KB file asked for "two lines" and
 * handed back all 60 KB. Line count is not a proxy for size, and an oversized
 * tool result is how a long session runs itself out of context.
 *
 * The cap must never silently swallow evidence: it reports how much it dropped
 * and which line to continue from, and it never returns nothing.
 * [gate: tool-result-context-budget]
 * Run: node scripts/test-tool-result-budget.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { samplePath, extractPath } = require("../src/main/mcp/file-intelligence-core.js");
const {
  DEFAULT_MAX_RESULT_BYTES,
  MAX_RESULT_BYTES_CEILING,
  capResultText,
  resultByteBudget,
} = require("../src/main/mcp/file-intelligence-result-budget.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-result-budget-"));
const write = (name, body) => {
  const full = path.join(tmp, name);
  fs.writeFileSync(full, body);
  return full;
};

try {
  const longLine = write("single_long_line.txt", `${"x".repeat(60_000)}\n${"y".repeat(200)}\n`);
  const manyLines = write("many.txt", Array.from({ length: 400 }, (_, i) => `line ${i} ${"z".repeat(60)}`).join("\n"));
  const small = write("small.txt", "alpha\nbeta\ngamma\n");

  check("the field case: two lines totalling 60 KB come back inside the byte budget", () => {
    const result = samplePath({ path: longLine, lines: 2 });
    assert.equal(result.ok, true);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= DEFAULT_MAX_RESULT_BYTES,
      `returned ${Buffer.byteLength(result.text, "utf8")} bytes`);
    assert.equal(result.truncated, true);
    assert.ok(result.truncatedBytes > 50_000, "it says how much it dropped");
    assert.equal(result.truncatedWithinLine, true, "one line bigger than the budget is cut mid-line");
    assert.ok(result.text.length > 0, "a cap must never return nothing");
    assert.match(result.warning, /byte budget/);
    assert.ok(Number.isInteger(result.nextLine), "the caller is told where to continue");
  });

  check("a normal sample is untouched and keeps its exact previous shape", () => {
    const result = samplePath({ path: small, lines: 40 });
    assert.equal(result.text, "alpha\nbeta\ngamma");
    assert.equal(result.truncated, undefined, "nothing is flagged when nothing was cut");
    assert.equal(result.nextLine, undefined);
    assert.equal(result.warning, "Sampled evidence is not full-file coverage.");
    assert.equal(result.coverage, "sampled");
    assert.equal(result.rangeEnd, 3);
  });

  check("a big line range is cut on a line boundary and resumable", () => {
    const result = extractPath({ path: manyLines, range: { type: "lines", start: 1, end: 400 } });
    assert.equal(result.ok, true);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= DEFAULT_MAX_RESULT_BYTES);
    assert.equal(result.truncated, true);
    assert.equal(result.truncatedWithinLine, undefined, "whole lines are kept where they fit");
    assert.ok(result.rangeEnd < 400 && result.rangeEnd >= 1);
    assert.equal(result.nextLine, result.rangeEnd + 1);
    assert.ok(result.text.startsWith("line 0 "), "the cut keeps the head, not a fragment");
    const next = extractPath({ path: manyLines, range: { type: "lines", start: result.nextLine, end: 400 } });
    assert.ok(next.text.startsWith(`line ${result.rangeEnd} `), "continuing from nextLine resumes exactly where it stopped");
  });

  check("a whole-file read no longer claims full coverage for a partial read", () => {
    const result = extractPath({ path: longLine, range: {} });
    assert.equal(result.coverage, "partial", "coverage tells the truth about what is in text");
    assert.equal(result.truncated, true);
  });

  check("the budget is caller-tunable within bounds, and a bad value falls back to the default", () => {
    assert.equal(resultByteBudget({}, {}), DEFAULT_MAX_RESULT_BYTES);
    assert.equal(resultByteBudget({ maxResultBytes: 4096 }), 4096);
    assert.equal(resultByteBudget({ maxResultBytes: 1 }), 512, "a floor keeps the result useful");
    assert.equal(resultByteBudget({ maxResultBytes: 99 * 1024 * 1024 }), MAX_RESULT_BYTES_CEILING);
    assert.equal(resultByteBudget({ maxResultBytes: "nonsense" }), DEFAULT_MAX_RESULT_BYTES);
    const wide = samplePath({ path: longLine, lines: 2, maxResultBytes: 32 * 1024 });
    assert.ok(Buffer.byteLength(wide.text, "utf8") > DEFAULT_MAX_RESULT_BYTES, "an explicit larger budget is honoured");
  });

  check("multi-byte characters are never cut into a broken glyph", () => {
    const capped = capResultText("中".repeat(100), { maxBytes: 512, rangeStart: 1, rangeEnd: 1 });
    assert.equal(Buffer.byteLength(capped.text, "utf8") <= 512, true);
    assert.ok(!capped.text.includes("�"), "no replacement character at the cut");
    assert.equal([...capped.text].every((ch) => ch === "中"), true);
  });

  console.log(`\n${checks} checks passed (tool result budget)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
