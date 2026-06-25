#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { EvidenceLedger, normalizeToolEvidence } = require("../src/main/evidence-ledger.js");

const grep = normalizeToolEvidence({
  name: "grep",
  input: { pattern: "session.idle", path: "src/main" },
  result: "src/main/runtime/opencode-runtime-reducer.js:412:session.idle",
  status: "done",
});
assert.equal(grep.kind, "file_search");
assert(grep.candidates.some((item) => item.includes("opencode-runtime-reducer.js")));

const read = normalizeToolEvidence({
  name: "read",
  input: { file_path: "src/main/turn-orchestrator.js", offset: 10, limit: 20 },
  result: "content",
  status: "done",
});
assert.equal(read.kind, "file_read");
assert.equal(read.path, "src/main/turn-orchestrator.js");
assert.deepEqual(read.lines, [10, 30]);

const bash = normalizeToolEvidence({
  name: "bash",
  input: { command: "node scripts/test-evidence-gate.mjs" },
  result: "evidence-gate: ok",
  status: "done",
});
assert.equal(bash.kind, "verification");
assert.equal(bash.success, true);

const ledger = new EvidenceLedger();
ledger.addWorkspaceCandidates([
  { relativePath: "src/main/turn-orchestrator.js" },
  { relativePath: "src/main/evidence-gate.js" },
]);
ledger.recordTool({ name: "grep", input: { pattern: "session.idle" }, result: grep.candidates.join("\n"), status: "done" });
ledger.recordTool({ name: "read", input: { file_path: "src/main/turn-orchestrator.js" }, result: "content", status: "done" });
ledger.recordTool({ name: "bash", input: { command: "npm test" }, result: "passed", status: "done" });
const summary = ledger.summary();
assert.equal(summary.counts.fileSearches, 1);
assert.equal(summary.counts.filesRead, 1);
assert.equal(summary.counts.verifications, 1);
assert(summary.coverage.candidateCount >= 2);
assert(summary.coverage.inspectedCount >= 1);
assert.equal(summary.coverage.fullInspection, false);
assert(summary.coverage.inspectedRatio > 0 && summary.coverage.inspectedRatio < 1);
assert(summary.coverage.inspectedCandidates.includes("src/main/turn-orchestrator.js"));
assert(summary.coverage.missingCandidates.includes("src/main/evidence-gate.js"));
assert(summary.coverage.readFiles.includes("src/main/turn-orchestrator.js"));
assert(summary.hasVerificationEvidence);

console.log("evidence-ledger: ok");
