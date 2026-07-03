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

const architectureWithoutSearch = assessFinalAnswerEvidence({
  assistant: "系统比较笨的地方是任务入口没有稳定契约。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["file_search", "file_read"] },
  turnPolicy: { rigor: "grounded", taskType: "architecture_audit" },
  evidenceSummary: { counts: { filesRead: 2 }, hasFileReadEvidence: true, hasSearchEvidence: false },
});
assert.equal(architectureWithoutSearch.ok, false);
assert.equal(architectureWithoutSearch.reason, "missing_required_evidence:file_search");

const architectureWithoutRead = assessFinalAnswerEvidence({
  assistant: "系统比较笨的地方是任务入口没有稳定契约。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["file_search", "file_read"] },
  turnPolicy: { rigor: "grounded", taskType: "architecture_audit" },
  evidenceSummary: { counts: { fileSearches: 1, filesRead: 0 }, hasSearchEvidence: true, hasFileReadEvidence: false },
});
assert.equal(architectureWithoutRead.ok, false);
assert.equal(architectureWithoutRead.reason, "missing_required_evidence:file_read");

const architectureWithRequiredEvidence = assessFinalAnswerEvidence({
  assistant: "系统比较笨的地方是任务入口没有稳定契约。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["file_search", "file_read"] },
  turnPolicy: { rigor: "grounded", taskType: "architecture_audit" },
  evidenceSummary: { counts: { fileSearches: 1, filesRead: 2 }, hasSearchEvidence: true, hasFileReadEvidence: true },
});
assert.equal(architectureWithRequiredEvidence.ok, true);

const simpleCodeChangeWithoutSearch = assessFinalAnswerEvidence({
  assistant: "已完成这个按钮样式修改。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "code_change", requiresSourceCoverage: false },
  evidenceSummary: { counts: { filesRead: 1, fileWrites: 1 }, hasFileReadEvidence: true, hasFileChangeEvidence: true },
});
assert.equal(simpleCodeChangeWithoutSearch.ok, true, "narrow known-file edits should not require broad search");

const codeFindingWithoutCallSearch = assessFinalAnswerEvidence({
  assistant: "这个 SQL 是 bug，会导致统计错误。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "code_change", requiresSourceCoverage: true },
  evidenceSummary: { counts: { fileSearches: 0, filesRead: 1 }, hasSearchEvidence: false, hasFileReadEvidence: true },
});
assert.equal(codeFindingWithoutCallSearch.ok, false);
assert.equal(codeFindingWithoutCallSearch.reason, "source_claim_without_search_evidence");

const codeFindingWithCallSearch = assessFinalAnswerEvidence({
  assistant: "这个 SQL 是 bug，会导致统计错误。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "code_change", requiresSourceCoverage: true },
  evidenceSummary: { counts: { fileSearches: 1, filesRead: 1 }, hasSearchEvidence: true, hasFileReadEvidence: true },
});
assert.equal(codeFindingWithCallSearch.ok, true);

const documentWithoutExtraction = assessFinalAnswerEvidence({
  assistant: "文档解析失败，无法确认文件内容。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["document"] },
  turnPolicy: { rigor: "grounded", taskType: "document_work" },
  evidenceSummary: { counts: {}, hasDocumentEvidence: false },
});
assert.equal(documentWithoutExtraction.ok, true, "honest document-read failure disclosures should not be double-punished");

const documentContentClaimWithoutExtraction = assessFinalAnswerEvidence({
  assistant: "这份文档讲的是项目实施计划。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["document"] },
  turnPolicy: { rigor: "grounded", taskType: "document_work" },
  evidenceSummary: { counts: {}, hasDocumentEvidence: false },
});
assert.equal(documentContentClaimWithoutExtraction.ok, false);
assert.equal(documentContentClaimWithoutExtraction.reason, "missing_required_evidence:document");

const documentWithExtraction = assessFinalAnswerEvidence({
  assistant: "文档讲的是项目实施计划。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["document"] },
  turnPolicy: { rigor: "grounded", taskType: "document_work" },
  evidenceSummary: { counts: { documents: 1, documentChunks: 3 }, hasDocumentEvidence: true },
});
assert.equal(documentWithExtraction.ok, true);

const mediaRecognitionWithoutOutput = assessFinalAnswerEvidence({
  assistant: "图片里是一张产品海报。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "media_generation" },
  evidenceSummary: { counts: {}, hasFileChangeEvidence: false },
});
assert.equal(mediaRecognitionWithoutOutput.ok, true, "image recognition should not require an output file");

const mediaOutputWithoutEvidence = assessFinalAnswerEvidence({
  assistant: "图片已生成。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "media_generation" },
  evidenceSummary: { counts: { fileWrites: 0 }, hasFileChangeEvidence: false },
});
assert.equal(mediaOutputWithoutEvidence.ok, false);
assert.equal(mediaOutputWithoutEvidence.reason, "media_output_without_file_evidence");

const mediaWithOutput = assessFinalAnswerEvidence({
  assistant: "图片已生成。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "media_generation" },
  evidenceSummary: { counts: { fileWrites: 1 }, hasFileChangeEvidence: true },
});
assert.equal(mediaWithOutput.ok, true);

console.log("evidence-gate: ok");
