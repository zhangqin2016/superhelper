#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const output = execFileSync("node", ["scripts/run-intent-eval.mjs", "--json"], {
  encoding: "utf8",
});
const report = JSON.parse(output);
assert.equal(report.ok, true);
assert.equal(report.coverage.examples >= 10, true);
assert.equal(report.coverage.intents >= 10, true);
assert.equal(report.coverage.routes >= 10, true);

const liveOutput = execFileSync("node", ["scripts/run-intent-eval.mjs", "--json", "--broker"], {
  encoding: "utf8",
});
const liveReport = JSON.parse(liveOutput);
assert.equal(liveReport.ok, true);
assert.equal(liveReport.mode, "broker-route");
assert.deepEqual(liveReport.evaluatedDimensions, ["route", "must_not_route"]);
assert.equal(liveReport.coverage.examples >= 19, true);

assert.deepEqual(report.evaluatedDimensions, [], "validation-only mode must not imply live behavior coverage");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-intent-eval-"));
const actualPath = path.join(tmp, "actual.jsonl");
fs.writeFileSync(
  actualPath,
  [
    JSON.stringify({
      id: "office_pdf_to_ppt_001",
      intents: ["office"],
      route: ["lily-office-intent"],
      needs_clarification: false,
      verification: ["output_path"],
    }),
  ].join("\n"),
);

let failed = false;
try {
  execFileSync("node", ["scripts/run-intent-eval.mjs", "--actual", actualPath], {
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (err) {
  failed = true;
  const text = `${err.stdout || ""}${err.stderr || ""}`;
  assert.match(text, /missing route/);
}
assert.equal(failed, true, "actual route output missing required route steps must fail");

const completeActualPath = path.join(tmp, "complete-actual.jsonl");
const goldenRows = fs.readFileSync(
  "resources/skills-catalog/lily-intent-eval/references/golden.jsonl",
  "utf8",
).trim().split(/\r?\n/).map(JSON.parse);
fs.writeFileSync(
  completeActualPath,
  goldenRows.map((row) => JSON.stringify({
    id: row.id,
    intents: row.expected_intents,
    route: row.expected_route,
    needs_clarification: row.needs_clarification,
    verification: row.verification_required,
  })).join("\n"),
);
const actualReport = JSON.parse(execFileSync(
  "node",
  ["scripts/run-intent-eval.mjs", "--actual", completeActualPath, "--json"],
  { encoding: "utf8" },
));
assert.equal(actualReport.mode, "actual");
assert.deepEqual(
  actualReport.evaluatedDimensions,
  ["intents", "route", "must_not_route", "clarification", "verification"],
);
fs.rmSync(tmp, { recursive: true, force: true });

console.log("intent-eval: ok");
