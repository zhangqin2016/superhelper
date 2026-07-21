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

const list = normalizeToolEvidence({
  name: "list",
  input: { path: "src/main" },
  result: "src/main/evidence-gate.js\nsrc/main/tool-semantics.js",
  status: "done",
});
assert.equal(list.kind, "file_search", "ledger must follow registered read-only search tool semantics");
assert(list.candidates.some((item) => item.includes("evidence-gate.js")));

const lsp = normalizeToolEvidence({
  name: "lsp",
  input: { file_path: "src/main/evidence-ledger.js" },
  result: "symbols",
  status: "done",
});
assert.equal(lsp.kind, "file_read", "ledger must follow registered file-read tool semantics");
assert.equal(lsp.path, "src/main/evidence-ledger.js");

const patchResult = "Success. Updated the following files:\nM src/main/evidence-ledger.js";
const patch = normalizeToolEvidence({
  name: "apply_patch",
  input: { file_path: "src/main/evidence-ledger.js" },
  result: patchResult,
  status: "done",
});
assert.equal(patch.kind, "file_write", "ledger must count apply_patch as file-write evidence");
assert.equal(patch.path, "src/main/evidence-ledger.js");

const ledger = new EvidenceLedger();
ledger.addWorkspaceCandidates([
  { relativePath: "src/main/turn-orchestrator.js" },
  { relativePath: "src/main/evidence-gate.js" },
]);
ledger.recordTool({ name: "grep", input: { pattern: "session.idle" }, result: grep.candidates.join("\n"), status: "done" });
ledger.recordTool({ name: "list", input: { path: "src/main" }, result: list.candidates.join("\n"), status: "done" });
ledger.recordTool({ name: "read", input: { file_path: "src/main/turn-orchestrator.js" }, result: "content", status: "done" });
ledger.recordTool({ name: "lsp", input: { file_path: "src/main/evidence-ledger.js" }, result: "symbols", status: "done" });
ledger.recordTool({ name: "apply_patch", input: { file_path: "src/main/evidence-ledger.js" }, result: patchResult, status: "done" });
ledger.recordTool({ name: "bash", input: { command: "npm test" }, result: "passed", status: "done" });
ledger.recordDocumentExtraction({
  documents: [{ id: "doc1", label: "contract.pdf", charLength: 1200 }],
  chunks: [{ chunkId: "doc1-chunk1" }, { chunkId: "doc1-chunk2" }],
});
const summary = ledger.summary();
assert.equal(summary.counts.fileSearches, 2);
assert.equal(summary.counts.filesRead, 2);
assert.equal(summary.counts.verifications, 1);
assert.equal(summary.counts.fileWrites, 1);
assert.equal(summary.counts.documents, 1);
assert.equal(summary.counts.documentChunks, 2);
assert(summary.coverage.candidateCount >= 2);
assert(summary.coverage.inspectedCount >= 1);
assert.equal(summary.coverage.fullInspection, false);
assert(summary.coverage.inspectedRatio > 0 && summary.coverage.inspectedRatio < 1);
assert(summary.coverage.inspectedCandidates.includes("src/main/turn-orchestrator.js"));
assert(summary.coverage.missingCandidates.includes("src/main/evidence-gate.js"));
assert(summary.coverage.readFiles.includes("src/main/turn-orchestrator.js"));
assert(summary.hasVerificationEvidence);
assert(summary.hasDocumentEvidence);
assert(summary.hasSourceContentEvidence);
assert.equal(summary.sourceContentCoverage.status, "complete");

// A successful plain command (syntax check / curl / build script — not a known test
// runner) still counts as executed verification evidence; a failed one does not.
const commandLedger = new EvidenceLedger();
commandLedger.recordTool({ name: "bash", input: { command: "node --check output/app.js" }, result: "", status: "done" });
assert(commandLedger.summary().hasCommandEvidence);
assert(!commandLedger.summary().hasVerificationEvidence);
const failedCommandLedger = new EvidenceLedger();
failedCommandLedger.recordTool({ name: "bash", input: { command: "curl -sf http://localhost:9999" }, result: "refused", status: "failed" });
assert(!failedCommandLedger.summary().hasCommandEvidence);

const failedSourceLedger = new EvidenceLedger();
failedSourceLedger.recordVisionObservation({
  method: "vision_bridge",
  status: "unavailable",
  sourceCount: 1,
  failedCount: 1,
});
const failedSourceSummary = failedSourceLedger.summary();
assert.equal(failedSourceSummary.hasSourceContentEvidence, false, "failed recognition must not become source evidence");
assert.equal(failedSourceSummary.sourceContentCoverage.status, "unavailable");

console.log("evidence-ledger: ok");
