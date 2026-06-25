#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assessFinalAnswerEvidence,
  appendEvidenceGateNotice,
} = require("../src/main/evidence-gate.js");

const policy = { required: true };

const unsupported = assessFinalAnswerEvidence({
  assistant: "问题已经修复，根因是连接池配置错误。",
  evidencePolicy: policy,
});
assert.equal(unsupported.ok, false);
assert.equal(unsupported.reason, "strong_claim_without_evidence");
assert.match(appendEvidenceGateNotice("问题已经修复。", unsupported), /证据门槛/);

const withToolEvidence = assessFinalAnswerEvidence({
  assistant: "问题已经修复。",
  evidencePolicy: policy,
  toolCount: 1,
});
assert.equal(withToolEvidence.ok, true, "tool activity is evidence that the model observed concrete state");

const withTextEvidence = assessFinalAnswerEvidence({
  assistant: "原因是超时。证据：src/main/foo.js:12 的超时配置和测试输出。",
  evidencePolicy: policy,
});
assert.equal(withTextEvidence.ok, true, "explicit evidence markers satisfy the gate");

const casual = assessFinalAnswerEvidence({
  assistant: "你好，有什么可以帮你？",
  evidencePolicy: { required: false },
});
assert.equal(casual.ok, true);

const unsupportedRootCause = assessFinalAnswerEvidence({
  assistant: "根因是 session.idle 被广播到了同目录所有视图。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: {}, hasFileReadEvidence: false },
});
assert.equal(unsupportedRootCause.ok, false);
assert.equal(unsupportedRootCause.reason, "root_cause_without_source_evidence");

const supportedRootCause = assessFinalAnswerEvidence({
  assistant: "根因是 session.idle 被广播到了同目录所有视图。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { filesRead: 2 }, hasFileReadEvidence: true },
});
assert.equal(supportedRootCause.ok, true);

const unsupportedVerification = assessFinalAnswerEvidence({
  assistant: "已经验证通过。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { verifications: 0 }, hasVerificationEvidence: false },
});
assert.equal(unsupportedVerification.ok, false);
assert.equal(unsupportedVerification.reason, "verified_claim_without_verification");

const supportedFixFromDiff = assessFinalAnswerEvidence({
  assistant: "问题已经修复。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { fileWrites: 0 }, hasFileChangeEvidence: false },
  fileChangeCount: 1,
});
assert.equal(supportedFixFromDiff.ok, true);

const unsupportedCoverage = assessFinalAnswerEvidence({
  assistant: "已经找出全部 session.idle 问题。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "coverage" },
  evidenceSummary: { counts: {}, coverage: { candidateCount: 0, inspectedCount: 0 }, hasSearchEvidence: false },
});
assert.equal(unsupportedCoverage.ok, false);
assert.equal(unsupportedCoverage.reason, "coverage_claim_without_candidate_set");

const unsupportedCoverageNoFinding = assessFinalAnswerEvidence({
  assistant: "没有发现其他 session.idle 问题。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "coverage" },
  evidenceSummary: {
    counts: { fileSearches: 1, filesRead: 1 },
    coverage: { candidateCount: 2, inspectedCount: 1, fullInspection: false },
    hasSearchEvidence: true,
    hasFileReadEvidence: true,
  },
});
assert.equal(unsupportedCoverageNoFinding.ok, false);
assert.equal(unsupportedCoverageNoFinding.reason, "coverage_claim_without_full_inspection");

const coverageProgressUpdate = assessFinalAnswerEvidence({
  assistant: "还需要继续检查剩余文件，暂时不下最终结论。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "coverage" },
  evidenceSummary: {
    counts: { fileSearches: 1, filesRead: 1 },
    coverage: { candidateCount: 2, inspectedCount: 1, fullInspection: false },
    hasSearchEvidence: true,
    hasFileReadEvidence: true,
  },
});
assert.equal(coverageProgressUpdate.ok, true, "coverage turns can report incomplete progress without making final claims");

const supportedCoverageNoFinding = assessFinalAnswerEvidence({
  assistant: "没有发现其他 session.idle 问题。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "coverage" },
  evidenceSummary: {
    counts: { fileSearches: 1, filesRead: 2 },
    coverage: { candidateCount: 2, inspectedCount: 2, fullInspection: true },
    hasSearchEvidence: true,
    hasFileReadEvidence: true,
  },
});
assert.equal(supportedCoverageNoFinding.ok, true);

const unsupportedFresh = assessFinalAnswerEvidence({
  assistant: "最新版本已经发布。",
  evidencePolicy: policy,
  turnPolicy: { requiresFreshness: true },
  evidenceSummary: { counts: {}, hasFreshEvidence: false },
});
assert.equal(unsupportedFresh.ok, false);
assert.equal(unsupportedFresh.reason, "fresh_claim_without_fresh_evidence");

console.log("evidence-gate: ok");
