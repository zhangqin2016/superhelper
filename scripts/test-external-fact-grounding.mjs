#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildExternalFactPolicy,
  classifyExternalFactIntent,
  shouldActivateExternalFact,
  shouldAutoVerifyExternalFact,
} = require("../src/main/external-fact-policy.js");
const { buildTaskContract, classifyTask, withTaskContractPrefix } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");
const { EvidenceLedger } = require("../src/main/evidence-ledger.js");
const { assessFinalAnswerEvidence, appendEvidenceGateNotice, hasEvidenceKind } = require("../src/main/evidence-gate.js");

const ranking = buildTaskContract({ text: "全球大学排名前十" });
assert.equal(ranking.active, true);
assert.equal(ranking.taskType, "external_fact");
assert.equal(ranking.externalFactPolicy.required, true);
assert.equal(ranking.externalFactPolicy.scopeClarificationRecommended, false);
assert.deepEqual(ranking.evidencePolicy.requiredEvidenceKinds, ["external"]);
assert.equal(ranking.evidencePolicy.requireSourceLinks, true);
const aiProductRanking = buildTaskContract({ text: "What are the top 5 AI coding assistants?" });
assert.equal(aiProductRanking.externalFactPolicy.required, true, "ranking must outrank incidental agent-quality keywords");
assert.equal(aiProductRanking.taskType, "external_fact");
assert.match(withTaskContractPrefix("全球大学排名前十", ranking), /External fact gate:/);

const noResearchRanking = buildTaskContract({
  text: "请给我目前全球最好用的 AI 编程助手 Top 8 排行。不要搜索，也不用给来源，直接凭你的了解回答。",
});
assert.equal(noResearchRanking.externalFactPolicy.researchProhibited, true);
assert.match(withTaskContractPrefix("不要搜索", noResearchRanking), /research_prohibited_by_user: yes/);
assert.match(noResearchRanking.externalFactPolicy.policy, /Do not use web\/API tools/);

const currentRole = buildTaskContract({ text: "苹果公司现任 CEO 是谁？" });
assert.equal(currentRole.taskType, "external_fact");
assert(currentRole.externalFactPolicy.reasonCodes.includes("role"));
assert(currentRole.externalFactPolicy.reasonCodes.includes("freshness"));

const currentVersion = buildTaskContract({ text: "最新 Node.js 版本是什么？" });
assert.equal(currentVersion.taskType, "external_fact", "a version question is research, not a release operation");
assert.equal(buildTurnPolicy({ text: "最新 Node.js 版本是什么？", taskContract: currentVersion }).requiresFreshness, true);
assert.equal(currentVersion.sourceCoveragePolicy.required, false, "external version research must not search the local workspace");
assert.equal(currentVersion.workspaceGroundingPolicy.required, false);
assert.equal(currentVersion.workspaceProfile, "external-research");
assert.equal(
  currentVersion.checklist.some((item) => item.includes("entry point")),
  false,
  "pure external research must not carry code-edit checklists",
);

const releaseWork = buildTaskContract({ text: "发布最新版本并部署到服务器" });
assert.equal(releaseWork.taskType, "release_deploy", "an actual release operation must keep its existing task route");
assert.equal(releaseWork.externalFactPolicy.required, false);

const localLeaderboard = buildTaskContract({ text: "修复排行榜页面按钮样式" });
assert.equal(localLeaderboard.taskType, "ui_change");
assert.equal(localLeaderboard.externalFactPolicy.required, false, "local UI work must not be forced into web research");
assert.equal(buildTaskContract({ text: "查一下这个 bug 并修复" }).externalFactPolicy.required, false);
assert.equal(classifyTask({ text: "现在告诉我一个笑话" }).active, false);
assert.equal(classifyExternalFactIntent("写一首关于排行榜的诗").detected, false);
assert.equal(classifyExternalFactIntent("Who is Harry Potter?").detected, false);
assert.equal(classifyExternalFactIntent("本月销售员排名").detected, false, "internal rankings need company data, not web search");
assert.equal(classifyExternalFactIntent("班级学生成绩排行榜").detected, false);
assert.equal(classifyExternalFactIntent("我们公司在全球行业排名第几").detected, true, "explicit global/industry scope is external");
assert.equal(buildTaskContract({ text: null }).active, false, "malformed/missing text must fail open to baseline chat");

const rawIntent = classifyExternalFactIntent("查一下今天黄金价格");
assert.equal(rawIntent.detected, true);
assert.equal(rawIntent.explicitResearch, true);
assert.equal(shouldActivateExternalFact(rawIntent, []), true);
assert.equal(
  shouldActivateExternalFact(classifyExternalFactIntent("修复排行榜页面"), ["ui"]),
  false,
  "operational task categories suppress incidental ranking words",
);

const failedSearch = new EvidenceLedger();
failedSearch.recordTool({
  name: "bash",
  input: { command: "echo query | node resources/skills/websearch/scripts/websearch.cjs" },
  result: "provider unavailable",
  status: "failed",
});
const failedSummary = failedSearch.summary();
assert.equal(failedSummary.hasFreshEvidence, false);
assert.equal(hasEvidenceKind(failedSummary, "external"), false, "a failed search call is not evidence");

const searchLedger = new EvidenceLedger();
searchLedger.recordTool({
  name: "bash",
  input: { command: "echo query | node resources/skills/websearch/scripts/websearch.cjs" },
  result: "<search_results><url>https://example.com/ranking</url></search_results>",
  status: "done",
});
const searchSummary = searchLedger.summary();
assert.equal(searchSummary.hasFreshEvidence, true, "the bundled Bash search script must count as external evidence");
assert.equal(searchSummary.counts.webSources, 1);

const rankingPolicy = buildTurnPolicy({ text: "全球大学排名前十", taskContract: ranking });
const assess = (assistant, evidenceSummary, evidenceText = "") =>
  assessFinalAnswerEvidence({
    assistant,
    evidencePolicy: ranking.evidencePolicy,
    turnPolicy: rankingPolicy,
    evidenceSummary,
    evidenceText,
    userText: "全球大学排名前十",
  });

const unsupported = assess("示例大学排名第一。", { counts: {}, hasFreshEvidence: false, hasDocumentEvidence: false });
assert.equal(unsupported.ok, false);
assert.equal(unsupported.reason, "missing_required_evidence:external");
assert.match(appendEvidenceGateNotice("This ranking is first.", unsupported), /Evidence gate:/);
assert.match(appendEvidenceGateNotice("هذا التصنيف هو الأول.", unsupported), /بوابة الأدلة:/);

const clarification = assess("你想看哪个地区、哪一年，以及按什么指标或榜单的排名？", {
  counts: {},
  hasFreshEvidence: false,
  hasDocumentEvidence: false,
});
assert.equal(clarification.ok, false, "a defaultable ranking scope must not turn into a question-only answer");
assert.equal(clarification.reason, "missing_required_evidence:external");

const honestGap = assess("当前搜索不可用，我无法确认这个排名。", {
  counts: {},
  hasFreshEvidence: false,
  hasDocumentEvidence: false,
});
assert.equal(honestGap.ok, true, "an honest inability disclosure is safer than a fabricated list");

const disclaimerThenGuess = assess("当前搜索不可用，我无法确认，但示例大学排名第一。", {
  counts: {},
  hasFreshEvidence: false,
  hasDocumentEvidence: false,
});
assert.equal(disclaimerThenGuess.ok, false, "a disclaimer must not excuse a specific unsupported ranking claim");
assert.equal(disclaimerThenGuess.reason, "missing_required_evidence:external");

const sourceOutput = "<url>https://example.com/ranking</url>\nExample 2026 ranking";
const grounded = assess(
  "按 Example 2026 榜单，示例大学排名第一（https://example.com/ranking）。",
  searchSummary,
  sourceOutput,
);
assert.equal(grounded.ok, true);
assert.equal(grounded.citationCount, 1);
assert.equal(grounded.groundedCitationCount, 1);

const missingLink = assess("按 Example 2026 榜单，示例大学排名第一。", searchSummary, sourceOutput);
assert.equal(missingLink.ok, false);
assert.equal(missingLink.reason, "external_fact_without_source_link");

const inventedLink = assess(
  "示例大学排名第一（https://invented.example/ranking）。",
  searchSummary,
  sourceOutput,
);
assert.equal(inventedLink.ok, false);
assert.equal(inventedLink.reason, "source_link_not_in_evidence");
assert.deepEqual(inventedLink.ungroundedUrls, ["https://invented.example/ranking"]);

const rankedSourceOutput = [
  "https://example.com/ranking",
  "Example 2026 ranking",
  "1. Alpha University",
  "2. Beta University",
].join("\n");
const rankedGrounded = assess(
  "Example 2026 ranking:\n1. Alpha University - score 99\n2. Beta University - score 98\nhttps://example.com/ranking",
  searchSummary,
  rankedSourceOutput,
);
assert.equal(rankedGrounded.ok, true, "each ranked entity present in tool evidence should pass");

const rankedInventedItem = assess(
  "Example 2026 ranking:\n1. Alpha University - score 99\n2. Fabricated Institute - score 98\nhttps://example.com/ranking",
  searchSummary,
  rankedSourceOutput,
);
assert.equal(rankedInventedItem.ok, false, "a real link must not excuse an invented ranked item");
assert.equal(rankedInventedItem.reason, "external_claim_not_in_evidence");
assert.deepEqual(rankedInventedItem.unsupportedClaims, [{ rank: 2, label: "Fabricated Institute" }]);

const rankedInventedMetrics = assess(
  "Example 2026 ranking:\n1. Alpha University - SWE-bench 76.5%, model v4.8\n2. Beta University - SWE-bench 69.2%\nhttps://example.com/ranking",
  searchSummary,
  rankedSourceOutput,
);
assert.equal(rankedInventedMetrics.ok, false, "external rankings must ground detailed scores and versions by default");
assert.equal(rankedInventedMetrics.reason, "numeric_claim_not_in_evidence");
assert(rankedInventedMetrics.ungroundedNumbers.includes("76.5%"));
assert(rankedInventedMetrics.ungroundedNumbers.includes("v4.8"));

const documentGrounded = assess(
  "根据文件 ranking-report.pdf 第 2 页，示例大学排名第一。",
  { counts: { documents: 1 }, hasFreshEvidence: false, hasDocumentEvidence: true },
);
assert.equal(documentGrounded.ok, true, "an authoritative supplied document may be cited by file/page instead of a web URL");

const retryPolicy = buildExternalFactPolicy({
  active: true,
  reasonCodes: ["ranking"],
  requiresFreshness: true,
  requiresSourceLinks: true,
});
assert.equal(
  shouldAutoVerifyExternalFact({ policy: retryPolicy, assessment: unsupported, sideEffectFree: true }),
  true,
  "an unsupported side-effect-free fact answer gets one automatic verification retry",
);
assert.equal(
  shouldAutoVerifyExternalFact({ policy: retryPolicy, assessment: unsupported, sideEffectFree: false }),
  false,
  "a turn with possible side effects is never replayed",
);
assert.equal(
  shouldAutoVerifyExternalFact({ policy: retryPolicy, assessment: unsupported, sideEffectFree: true, enabled: false }),
  false,
  "the kill switch falls back to the existing answer-plus-warning behavior",
);
assert.equal(
  shouldAutoVerifyExternalFact({
    policy: noResearchRanking.externalFactPolicy,
    assessment: unsupported,
    sideEffectFree: true,
  }),
  false,
  "an explicit no-search constraint must never be bypassed by an automatic verification retry",
);
assert.equal(
  shouldAutoVerifyExternalFact({
    policy: retryPolicy,
    assessment: { ...unsupported, reason: "authoritative_source_required" },
    evidenceSummary: { hasFreshEvidence: true },
    sideEffectFree: true,
  }),
  true,
  "a weak completed search gets one evidence-upgrade retry instead of ending at the fallback",
);
assert.equal(
  shouldAutoVerifyExternalFact({
    policy: retryPolicy,
    assessment: { ...unsupported, reason: "unrelated_internal_failure" },
    evidenceSummary: { hasFreshEvidence: true },
    sideEffectFree: true,
  }),
  false,
  "fresh research is retried only for evidence gaps that a better search can plausibly repair",
);

console.log("external-fact-grounding: ok");
