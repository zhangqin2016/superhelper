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

// --- deterministic numeric grounding (zero model calls) ---------------------
// The 张钦 failure: tools ran, so hasEvidence was true, but the specific counts
// were fabricated. A data number absent from the tool output AND the user prompt
// is flagged by name.
const fabricatedNumber = assessFinalAnswerEvidence({
  assistant: "数据共 27,448 条记录，阿语覆盖率 39%。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { taskType: "general" },
  evidenceSummary: { counts: { events: 1 } },
  toolCount: 1,
  evidenceText: "ls output/ => uae-data.json (6.6 MB); file exists",
  userText: "这些数据全吗",
});
assert.equal(fabricatedNumber.ok, false, "a fabricated count absent from tool output is flagged even though tools ran");
assert.equal(fabricatedNumber.reason, "numeric_claim_not_in_evidence");
assert.ok(fabricatedNumber.ungroundedNumbers.includes("27,448"), "the ungrounded number is named");

// Same number present in the tool output (comma-normalized) → grounded.
const groundedNumber = assessFinalAnswerEvidence({
  assistant: "数据共 27,448 条记录。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { taskType: "general" }, toolCount: 1,
  evidenceText: "python count => total 27448 records", userText: "",
});
assert.equal(groundedNumber.ok, true, "a number present in the tool output (27448) is grounded");

// A number the user themselves supplied is not treated as fabricated.
const fromUser = assessFinalAnswerEvidence({
  assistant: "你提供的 12345 条记录我已纳入本次分析。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { taskType: "general" }, toolCount: 1,
  evidenceText: "", userText: "帮我核对这 12345 条记录",
});
assert.equal(fromUser.ok, true, "a number from the user's own prompt is grounded");

// Small/round numbers (<=3 digits, no separator, no %) are NOT checked → no false positive.
const smallNumbers = assessFinalAnswerEvidence({
  assistant: "有 7 个酋长国，约 100 个区域。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { taskType: "general" }, toolCount: 1,
  evidenceText: "output without those values", userText: "",
});
assert.equal(smallNumbers.ok, true, "small/round numbers are not numeric-grounding-flagged");

// Kill switch.
{
  process.env.LILY_NUMERIC_GROUNDING = "0";
  const off = assessFinalAnswerEvidence({
    assistant: "共 27,448 条。", evidencePolicy: { required: true, requiredEvidenceKinds: [] },
    turnPolicy: { taskType: "general" }, toolCount: 1, evidenceText: "nothing here", userText: "",
  });
  assert.equal(off.ok, true, "LILY_NUMERIC_GROUNDING=0 disables numeric grounding");
  delete process.env.LILY_NUMERIC_GROUNDING;
}

// The notice names the specific ungrounded numbers (targeted, not blanket).
const numNotice = appendEvidenceGateNotice("答案正文", { ok: false, reason: "numeric_claim_not_in_evidence", ungroundedNumbers: ["27,448", "39%"] });
assert.match(numNotice, /27,448、39%/, "the notice names the exact ungrounded numbers");

console.log("evidence-gate: ok");
