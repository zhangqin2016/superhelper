#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  assessFinalAnswerEvidence,
  hasEvidenceKind: egHasEvidenceKind,
} = require("../src/main/evidence-gate.js");

const policy = { required: true };

// HARD GATE KEPT: a strong claim with zero evidence of any kind (no tools, no
// ledger entries, no in-text evidence markers) still fails the literal floor.
const unsupported = assessFinalAnswerEvidence({
  assistant: "问题已经修复，根因是连接池配置错误。",
  evidencePolicy: policy,
});
assert.equal(unsupported.ok, false);
assert.equal(unsupported.reason, "strong_claim_without_evidence");

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

// ADVISORY-ONLY (2026-07-20 model-first direction): the mechanical SEMANTIC
// checks (root cause / verified / fixed / coverage / fresh / media output /
// source claim keyword matching) may NEVER fail an answer — models have
// infinite legitimate phrasings. They are recorded as advisoryReasons on an
// otherwise-passing assessment for the learning loop. Each case below gives
// the answer real evidence (so the literal strong-claim floor passes) and then
// asserts ok === true with the corresponding advisory reason recorded.
const advisoryRootCause = assessFinalAnswerEvidence({
  assistant: "根因是 session.idle 被广播到了同目录所有视图。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: {}, hasFileReadEvidence: false },
  toolCount: 1,
});
assert.equal(advisoryRootCause.ok, true, "a keyword root-cause claim no longer fails the gate");
assert.ok(advisoryRootCause.advisoryReasons.includes("root_cause_without_source_evidence"),
  "the mismatch is recorded as advisory telemetry for the learning loop");

const supportedRootCause = assessFinalAnswerEvidence({
  assistant: "根因是 session.idle 被广播到了同目录所有视图。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { filesRead: 2 }, hasFileReadEvidence: true },
});
assert.equal(supportedRootCause.ok, true);
assert.ok(!supportedRootCause.advisoryReasons?.includes("root_cause_without_source_evidence"),
  "real file-read evidence suppresses the advisory reason");

const advisoryVerification = assessFinalAnswerEvidence({
  assistant: "已经验证通过。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { verifications: 0 }, hasVerificationEvidence: false },
  toolCount: 1,
});
assert.equal(advisoryVerification.ok, true, "a keyword verified claim no longer fails the gate");
assert.ok(advisoryVerification.advisoryReasons.includes("verified_claim_without_verification"));

// A "verified" claim after a real successful command run (node --check, curl HTTP
// 200, build scripts — not a recognized test runner) is backed, not empty.
const commandBackedVerification = assessFinalAnswerEvidence({
  assistant: "语法检查通过，HTTP 200，验证通过。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { verifications: 0 }, hasVerificationEvidence: false, hasCommandEvidence: true },
});
assert.equal(commandBackedVerification.ok, true);
assert.ok(!commandBackedVerification.advisoryReasons?.includes("verified_claim_without_verification"),
  "command evidence suppresses the verified-claim advisory reason");

const supportedFixFromDiff = assessFinalAnswerEvidence({
  assistant: "问题已经修复。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "grounded" },
  evidenceSummary: { counts: { fileWrites: 0 }, hasFileChangeEvidence: false },
  fileChangeCount: 1,
});
assert.equal(supportedFixFromDiff.ok, true);
assert.ok(!supportedFixFromDiff.advisoryReasons?.includes("fixed_claim_without_change_evidence"));

const advisoryCoverage = assessFinalAnswerEvidence({
  assistant: "已经找出全部 session.idle 问题。",
  evidencePolicy: policy,
  turnPolicy: { rigor: "coverage" },
  evidenceSummary: { counts: {}, coverage: { candidateCount: 0, inspectedCount: 0 }, hasSearchEvidence: false },
});
assert.equal(advisoryCoverage.ok, true, "a keyword coverage claim no longer fails the gate");
assert.ok(advisoryCoverage.advisoryReasons.includes("coverage_claim_without_candidate_set"));

const advisoryCoverageNoFinding = assessFinalAnswerEvidence({
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
assert.equal(advisoryCoverageNoFinding.ok, true, "partial coverage inspection no longer fails the gate");
assert.ok(advisoryCoverageNoFinding.advisoryReasons.includes("coverage_claim_without_full_inspection"));

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
assert.ok(!supportedCoverageNoFinding.advisoryReasons?.some((r) => r.startsWith("coverage_claim")),
  "full inspection suppresses the coverage advisory reasons");

const advisoryFresh = assessFinalAnswerEvidence({
  assistant: "最新版本已经发布。",
  evidencePolicy: policy,
  turnPolicy: { requiresFreshness: true },
  evidenceSummary: { counts: {}, hasFreshEvidence: false },
  toolCount: 1,
});
assert.equal(advisoryFresh.ok, true, "a keyword freshness claim no longer fails the gate");
assert.ok(advisoryFresh.advisoryReasons.includes("fresh_claim_without_fresh_evidence"));

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

const advisoryCodeFinding = assessFinalAnswerEvidence({
  assistant: "这个 SQL 是 bug，会导致统计错误。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "code_change", requiresSourceCoverage: true },
  evidenceSummary: { counts: { fileSearches: 0, filesRead: 1 }, hasSearchEvidence: false, hasFileReadEvidence: true },
});
assert.equal(advisoryCodeFinding.ok, true, "a keyword bug/cause claim no longer fails the gate");
assert.ok(advisoryCodeFinding.advisoryReasons.includes("source_claim_without_search_evidence"));

const codeFindingWithCallSearch = assessFinalAnswerEvidence({
  assistant: "这个 SQL 是 bug，会导致统计错误。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "code_change", requiresSourceCoverage: true },
  evidenceSummary: { counts: { fileSearches: 1, filesRead: 1 }, hasSearchEvidence: true, hasFileReadEvidence: true },
});
assert.equal(codeFindingWithCallSearch.ok, true);
assert.ok(!codeFindingWithCallSearch.advisoryReasons?.includes("source_claim_without_search_evidence"));

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

const documentOutputMissing = assessFinalAnswerEvidence({
  assistant: "The requested report has been delivered.",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["document_output"] },
  turnPolicy: { rigor: "grounded", taskType: "document_work" },
  evidenceSummary: { counts: {}, hasDocumentOutputEvidence: false },
});
assert.equal(documentOutputMissing.ok, false);
assert.equal(documentOutputMissing.reason, "missing_required_evidence:document_output");

const documentOutputPresent = assessFinalAnswerEvidence({
  assistant: "The requested report has been delivered.",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["document_output"] },
  turnPolicy: { rigor: "grounded", taskType: "document_work" },
  evidenceSummary: { counts: { documentOutputs: 1 }, hasDocumentOutputEvidence: true },
});
assert.equal(documentOutputPresent.ok, true);

const mediaRecognitionWithoutOutput = assessFinalAnswerEvidence({
  assistant: "图片里是一张产品海报。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "media_generation" },
  evidenceSummary: { counts: {}, hasFileChangeEvidence: false },
});
assert.equal(mediaRecognitionWithoutOutput.ok, true, "image recognition should not require an output file");

const sourceClaimWithoutRead = assessFinalAnswerEvidence({
  assistant: "图片里是一张产品海报。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["source_content"] },
  turnPolicy: { rigor: "grounded", taskType: "content_extraction" },
  evidenceSummary: { counts: { sourceContentSources: 1 }, hasSourceContentEvidence: false },
});
assert.equal(sourceClaimWithoutRead.ok, false);
assert.equal(sourceClaimWithoutRead.reason, "missing_required_evidence:source_content");

const sourceClaimWithRead = assessFinalAnswerEvidence({
  assistant: "图片里是一张产品海报。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["source_content"] },
  turnPolicy: { rigor: "grounded", taskType: "content_extraction" },
  evidenceSummary: { counts: { sourceContentSources: 1 }, hasSourceContentEvidence: true },
});
assert.equal(sourceClaimWithRead.ok, true);

const partialSourceWithoutDisclosure = assessFinalAnswerEvidence({
  assistant: "这份文档完整说明了项目实施计划。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["source_content"] },
  turnPolicy: { rigor: "grounded", taskType: "content_extraction" },
  evidenceSummary: {
    counts: { sourceContentSources: 2 },
    hasSourceContentEvidence: true,
    sourceContentCoverage: { status: "partial" },
  },
});
assert.equal(partialSourceWithoutDisclosure.ok, false);
assert.equal(partialSourceWithoutDisclosure.reason, "partial_source_content_without_disclosure");

const partialSourceWithDisclosure = assessFinalAnswerEvidence({
  assistant: "目前只读取到部分页面；在已读取部分中，文档说明了项目实施计划。",
  evidencePolicy: { required: true, requiredEvidenceKinds: ["source_content"] },
  turnPolicy: { rigor: "grounded", taskType: "content_extraction" },
  evidenceSummary: {
    counts: { sourceContentSources: 2 },
    hasSourceContentEvidence: true,
    sourceContentCoverage: { status: "partial" },
  },
});
assert.equal(partialSourceWithDisclosure.ok, true);

const advisoryMediaOutput = assessFinalAnswerEvidence({
  assistant: "图片已生成。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "media_generation" },
  evidenceSummary: { counts: { fileWrites: 0 }, hasFileChangeEvidence: false },
});
assert.equal(advisoryMediaOutput.ok, true, "a keyword media-output claim no longer fails the gate");
assert.ok(advisoryMediaOutput.advisoryReasons.includes("media_output_without_file_evidence"));

const mediaWithOutput = assessFinalAnswerEvidence({
  assistant: "图片已生成。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { rigor: "grounded", taskType: "media_generation" },
  evidenceSummary: { counts: { fileWrites: 1 }, hasFileChangeEvidence: true },
});
assert.equal(mediaWithOutput.ok, true);
assert.ok(!mediaWithOutput.advisoryReasons?.includes("media_output_without_file_evidence"));

// --- numeric grounding (DEFAULT OFF; opt-in LILY_NUMERIC_GROUNDING=1) --------
// It false-flagged correct numbers too often (computed-then-written-to-file /
// vision-read values that never appear in stdout), so by default it is disabled
// and the gate keeps its conservative pre-existing behavior.
const numericDefaultOff = assessFinalAnswerEvidence({
  assistant: "数据共 27,448 条记录，阿语覆盖率 39%。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { taskType: "general" }, toolCount: 1,
  evidenceSummary: { counts: { events: 1 } },
  evidenceText: "ls output/ => uae-data.json", userText: "这些数据全吗",
});
assert.equal(numericDefaultOff.ok, true, "numeric grounding is OFF by default — no false 'unverified' on a computed answer");

// Opt-in behavior (LILY_NUMERIC_GROUNDING=1): flags data numbers absent from tool output/prompt.
{
  process.env.LILY_NUMERIC_GROUNDING = "1";

  const fabricatedNumber = assessFinalAnswerEvidence({
    assistant: "数据共 27,448 条记录，阿语覆盖率 39%。",
    evidencePolicy: { required: true, requiredEvidenceKinds: [] },
    turnPolicy: { taskType: "general" }, toolCount: 1,
    evidenceSummary: { counts: { events: 1 } },
    evidenceText: "ls output/ => uae-data.json (6.6 MB); file exists", userText: "这些数据全吗",
  });
  assert.equal(fabricatedNumber.ok, false, "opt-in: a fabricated count absent from tool output is flagged");
  assert.equal(fabricatedNumber.reason, "numeric_claim_not_in_evidence");
  assert.ok(fabricatedNumber.ungroundedNumbers.includes("27,448"), "the ungrounded number is named");

  const groundedNumber = assessFinalAnswerEvidence({
    assistant: "数据共 27,448 条记录。",
    evidencePolicy: { required: true, requiredEvidenceKinds: [] },
    turnPolicy: { taskType: "general" }, toolCount: 1,
    evidenceText: "python count => total 27448 records", userText: "",
  });
  assert.equal(groundedNumber.ok, true, "opt-in: a number present in the tool output (27448) is grounded");

  const fromUser = assessFinalAnswerEvidence({
    assistant: "你提供的 12345 条记录我已纳入本次分析。",
    evidencePolicy: { required: true, requiredEvidenceKinds: [] },
    turnPolicy: { taskType: "general" }, toolCount: 1,
    evidenceText: "", userText: "帮我核对这 12345 条记录",
  });
  assert.equal(fromUser.ok, true, "opt-in: a number from the user's own prompt is grounded");

  const smallNumbers = assessFinalAnswerEvidence({
    assistant: "有 7 个酋长国，约 100 个区域。",
    evidencePolicy: { required: true, requiredEvidenceKinds: [] },
    turnPolicy: { taskType: "general" }, toolCount: 1,
    evidenceText: "output without those values", userText: "",
  });
  assert.equal(smallNumbers.ok, true, "opt-in: small/round numbers are not flagged");

  // Even opt-in, image/vision turns are exempt.
  const imgOptIn = assessFinalAnswerEvidence({
    assistant: "编号 0016953543，总游玩 1,286 局。",
    evidencePolicy: { required: true, requiredEvidenceKinds: [] },
    turnPolicy: { taskType: "general" }, toolCount: 1,
    evidenceText: "Image analysis complete", userText: "分析", skipNumericGrounding: true,
  });
  assert.equal(imgOptIn.ok, true, "opt-in: image-read numbers still exempt (skipNumericGrounding)");

  delete process.env.LILY_NUMERIC_GROUNDING;
}

// Image/vision turns are EXEMPT from numeric grounding — the numbers were READ
// from the image (vision is the evidence), so flagging them is a false positive
// (the field regression: an image analysis got its numbers flagged, then an
// enabled verify-retry re-ran and drifted to an unrelated task).
const imageAnalysis = assessFinalAnswerEvidence({
  assistant: "编号 0016953543，总游玩 1,286 局，夺冠率约 47%，赛季潮流度 3242。",
  evidencePolicy: { required: true, requiredEvidenceKinds: [] },
  turnPolicy: { taskType: "general" }, toolCount: 1,
  evidenceText: "Image analysis complete", userText: "分析",
  skipNumericGrounding: true,
});
assert.equal(imageAnalysis.ok, true, "image-read numbers are NOT numeric-grounding-flagged (vision is the evidence)");

// knowledge_base is a first-class required-evidence kind: satisfied by a
// successful local KB query, unsatisfied without one.
assert.equal(egHasEvidenceKind({ hasKnowledgeBaseEvidence: true, counts: { knowledgeBaseQueries: 1 } }, "knowledge_base"), true);
assert.equal(egHasEvidenceKind({ hasKnowledgeBaseEvidence: false, counts: { knowledgeBaseQueries: 0 } }, "knowledge_base"), false);
assert.equal(egHasEvidenceKind({ counts: { knowledgeBaseQueries: 2 } }, "knowledge_base"), true, "count fallback satisfies the kind");

console.log("evidence-gate: ok");
