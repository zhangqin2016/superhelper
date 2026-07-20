/**
 * Evidence risk tiers — the "delivered content never drops to zero" invariant.
 *
 * The gate's job is to prevent fabrication presented as fact, not to prevent
 * answers. These tests pin the tiered contract end-to-end through the REAL
 * evaluateAnswerEvidence pipeline:
 *   hard        — high-stakes asks (medical/legal/finance floor, or judge
 *                   stakes=high) may still be replaced (fail closed)
 *   verify_soft — failure keeps a bounded answer (original + banner / supported subset)
 *   advisory    — everyday domain vocabulary never controls rendering
 * Plus: ranking fabrication still falls back, Arabic triggers fire, the kill
 * switch restores exact legacy (all-hard) behavior, and internal gate errors
 * fail OPEN outside the hard tier.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const {
  classifyExternalFactIntent,
  buildExternalFactPolicy,
  externalFactRiskTier,
} = require("../src/main/external-fact-policy.js");
const { buildEvidencePolicy, withExternalFactPolicy } = require("../src/main/task-evidence-policy.js");
const {
  evaluateAnswerEvidence,
  evaluateAnswerEvidenceWithJudge,
  shouldBufferAssistantAnswer,
} = require("../src/main/answer-evidence-finalizer.js");
const { composeBoundedExternalAnswer } = require("../src/main/external-evidence-recovery.js");
const { normalizeVerificationPlan } = require("../src/main/external-claim-profiles.js");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok: ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function contractFor(text, plan = null) {
  const intent = classifyExternalFactIntent(text);
  const classification = { taskType: "external_fact", active: true, externalFactIntent: intent };
  const contract = {
    taskType: "external_fact",
    externalFactPolicy: buildExternalFactPolicy(intent),
    evidencePolicy: buildEvidencePolicy(classification),
  };
  if (plan) {
    // Model-first: semantics the turn-start detector cannot see arrive via the
    // model's verification-plan candidate (same shape as production refinement).
    const externalFact = buildExternalFactPolicy({
      active: true,
      reasonCodes: ["model_external_fact"],
      requiresFreshness: true,
      requiresSourceLinks: true,
      verificationPlan: normalizeVerificationPlan({ profileIds: ["model_semantic_claim"], ...plan }),
    });
    contract.externalFactPolicy = externalFact;
    contract.evidencePolicy = withExternalFactPolicy(contract.evidencePolicy, externalFact);
  }
  return contract;
}

function runGate(text, assistant, { evidenceSummary = { hasFreshEvidence: false }, recoveryAttempt = false } = {}) {
  return evaluateAnswerEvidence({
    assistant,
    taskContract: contractFor(text),
    turnPolicy: { taskType: "external_fact" },
    evidenceSummary,
    tools: [],
    userText: text,
    recoveryAttempt,
  });
}

// ---------------------------------------------------------------------------
console.log("tier classification:");
{
  const tier = (text) => {
    const policy = buildExternalFactPolicy(classifyExternalFactIntent(text));
    return policy.required ? externalFactRiskTier(policy) : "(inactive)";
  };
  check("high-stakes dosage → hard", tier("这个药的剂量是多少?") === "hard");
  check("fresh exchange rate → verify_soft", tier("现在最新的美元汇率是多少?") === "verify_soft");
  check("ranking → verify_soft", tier("2026年全球手机销量排行榜前十") === "verify_soft");
  // No domain vocabularies remain: everyday version/tax chat is simply not
  // detected at turn start (behaviorally identical to advisory — the answer
  // is never gated). The model can still declare a plan mid-turn.
  check("version chat → inactive", tier("Vue 3 新版本有什么特性?") === "(inactive)");
  check("plain tax-rate ask → inactive", tier("增值税税率是多少?") === "(inactive)");
  check("creative writing → inactive", tier("帮我写一首关于春天的诗") === "(inactive)");
  check("Arabic freshness → verify_soft", tier("ما هو أحدث سعر صرف الدولار؟") === "verify_soft");
  check("Arabic dosage → hard", tier("ما هي جرعة هذا الدواء؟") === "hard");
}

// ---------------------------------------------------------------------------
console.log("advisory: everyday asks keep their answer:");
{
  const text = "Vue 3 新版本有什么特性?";
  const answer = "Vue 3 引入了组合式 API、Teleport 与 Fragments,渲染性能也比 Vue 2 有明显提升。";
  const result = runGate(text, answer);
  check("advisory answer preserved verbatim or with notice", result.assistant.includes("组合式 API"),
    `got: ${result.assistant.slice(0, 120)}`);
  check("advisory never triggers forced retry", result.triggerVerifyRetry === false);
}

// ---------------------------------------------------------------------------
console.log("verify_soft: FINAL failure keeps a bounded answer (never zero content):");
{
  const text = "现在最新的美元兑人民币汇率是多少?";
  const answer = "美元兑人民币汇率大约在 7.2 左右,近期在 7.1-7.3 区间波动。";
  // First pass: an auto-verify retry is pending → interim stays conservative
  // (the retry's verified answer supersedes it).
  const firstPass = runGate(text, answer);
  check("verify_soft triggers auto verify retry", firstPass.triggerVerifyRetry === true);
  check("interim projection stays conservative while retry pends", !firstPass.assistant.includes("7.2"));
  // Final pass (retry already spent): the bounded-answer invariant applies.
  const finalPass = runGate(text, answer, { recoveryAttempt: true });
  check("final bounded answer keeps original content", finalPass.assistant.includes("7.2"),
    `got: ${finalPass.assistant.slice(0, 160)}`);
  check("final bounded answer carries verification banner", /核实说明|Verification note|ملاحظة تحقق/.test(finalPass.assistant));
  check("assessment flags boundedAnswer", finalPass.assessment?.boundedAnswer === true);
  check("assessment records riskTier", finalPass.assessment?.riskTier === "verify_soft");
}

// ---------------------------------------------------------------------------
console.log("verify_soft ranking with zero evidence: fabrication still falls back:");
{
  const text = "2026年全球手机销量排行榜前十是哪些?";
  const answer = "第一名是A公司,第二名是B公司,第三名是C公司,完整前十名单如下…";
  const result = runGate(text, answer);
  check("fabricated roster is NOT banner-kept", !result.assistant.includes("A公司"),
    `got: ${result.assistant.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
console.log("hard: high-stakes guarantee unchanged (fail closed):");
{
  const text = "这个药每天的剂量应该是多少毫克?";
  const answer = "每天服用 500 毫克即可,一日三次。";
  const result = runGate(text, answer);
  check("unverified dosage answer is replaced", !result.assistant.includes("500 毫克"),
    `got: ${result.assistant.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
console.log("kill switch restores legacy all-hard behavior:");
{
  process.env.LILY_EVIDENCE_RISK_TIERS = "0";
  const text = "现在最新的美元兑人民币汇率是多少?";
  const answer = "美元兑人民币汇率大约在 7.2 左右。";
  const result = runGate(text, answer);
  check("kill switch: rate answer replaced like legacy", !result.assistant.includes("7.2"),
    `got: ${result.assistant.slice(0, 160)}`);
  check("kill switch: no buffering (legacy streaming)",
    shouldBufferAssistantAnswer(contractFor("这个药的剂量是多少?")) === false);
  delete process.env.LILY_EVIDENCE_RISK_TIERS;
}

// ---------------------------------------------------------------------------
console.log("buffering (verify-before-stream) only where replacement is possible:");
{
  check("hard tier buffers", shouldBufferAssistantAnswer(contractFor("这个药的剂量是多少?")) === true);
  check("generic verify_soft streams", shouldBufferAssistantAnswer(contractFor("现在最新的美元汇率是多少?")) === false);
  check("researchable ranking streams (can pass the gate)",
    shouldBufferAssistantAnswer(contractFor("2026年全球手机销量排行榜前十")) === false);
  check("no-research ranking buffers (guaranteed replacement)",
    shouldBufferAssistantAnswer(contractFor("不要搜索,凭你的了解给我2026年全球手机销量排行榜前十")) === true);
  check("advisory streams", shouldBufferAssistantAnswer(contractFor("Vue 3 新版本有什么特性?")) === false);
  check("non-external contract streams", shouldBufferAssistantAnswer({ taskType: "general" }) === false);
}

// ---------------------------------------------------------------------------
console.log("verify_soft with real research: verified subset must be delivered (live 副部级 case):");
{
  // Field failure 2026-07-20: 8 real searches (sasac.gov.cn opened, evidence in
  // the ledger) still ended in TWO zero-content fallbacks. Model-first: the
  // detector stays silent on "副部级" (not coded); the MODEL declares the plan;
  // ONE semantic judge call rules authority + entailment + framing; the
  // supported subset is delivered, fabricated entities stripped by the floor.
  const text = "中国有哪些建筑公司是副部级别";
  const informalPlan = {
    entityEvidenceRequired: true,
    classificationEvidenceRequired: true,
    sourceAuthority: "official_primary",
  };
  const sasacUrl = "https://wap.sasac.gov.cn/n2588025/n2588139/c2820992/content.html";
  const evidenceText = `国资委央企名录 中国建筑集团有限公司排名第47位。前54家中管企业主要负责人由中共中央组织部任免。${sasacUrl}`;
  const answer = [
    "符合的企业名单:",
    `1. 中国建筑集团有限公司(央企名录第47位,${sasacUrl})`,
    "2. 湖南建工集团",
    "3. 北京城建集团",
  ].join("\n");
  const judgeStub = async ({ urls = [] }) => ({
    supportedClaims: ["中国建筑集团有限公司"],
    unsupportedClaims: [],
    authoritativeUrls: urls,
    conflictingClaims: [],
    informalLabel: true,
    framingNote: "副部级是行业对中管企业的俗称,并非官方正式认定。",
    stakes: "low",
  });
  const result = await evaluateAnswerEvidenceWithJudge({
    assistant: answer,
    taskContract: contractFor(text, informalPlan),
    turnPolicy: { taskType: "external_fact" },
    evidenceSummary: { hasFreshEvidence: true, counts: { webSources: 3 }, events: [{ kind: "web_search" }, { kind: "web_fetch" }] },
    tools: [{ name: "bash", input: { command: "echo q | node resources/skills/websearch/scripts/websearch.cjs" }, result: evidenceText }],
    userText: text,
  }, { judge: judgeStub });
  check("judge ruled on the turn (one semantic call)", result.assessment.semanticJudged === true);
  check("supported finding survives (中国建筑集团 第47位)", result.assistant.includes("第47位"),
    `got: ${result.assistant.slice(0, 200)}`);
  check("unsupported entities are stripped (fabrication floor)", !result.assistant.includes("湖南建工"));
  check("delivered content is never zero after real research",
    result.assistant.trim().length > 40 && !/^本轮没有取得可核验的实时来源/.test(result.assistant));
  // Judge unavailable → ordinary fail-open: bounded banner, still not zero.
  const judgeDown = await evaluateAnswerEvidenceWithJudge({
    assistant: answer,
    taskContract: contractFor(text, informalPlan),
    turnPolicy: { taskType: "external_fact" },
    evidenceSummary: { hasFreshEvidence: true, counts: { webSources: 3 } },
    tools: [{ name: "bash", input: { command: "echo q | node resources/skills/websearch/scripts/websearch.cjs" }, result: evidenceText }],
    userText: text,
  }, { judge: async () => null });
  check("judge-down ordinary ask fail-opens with a banner", judgeDown.assistant.includes("⚠️"),
    `got: ${judgeDown.assistant.slice(0, 160)}`);
  check("judge-down still strips fabricated entities", !judgeDown.assistant.includes("湖南建工"),
    `got: ${judgeDown.assistant.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
console.log("bounded composer unit behavior:");
{
  const policy = buildExternalFactPolicy(classifyExternalFactIntent("现在最新的美元汇率是多少?"));
  const bounded = composeBoundedExternalAnswer({
    assistant: "汇率大约 7.2。\n共10家银行提供该牌价,完整名单如下。",
    assessment: { ok: false, reason: "missing_required_evidence:external" },
    policy,
    evidenceSummary: { hasFreshEvidence: false },
    userText: "现在最新的美元汇率是多少?",
    recoveryAttempt: true,
  });
  check("composer keeps core content", Boolean(bounded?.assistant.includes("7.2")));
  check("composer strips completeness claims", !bounded.assistant.includes("完整名单"));
  const empty = composeBoundedExternalAnswer({
    assistant: "",
    assessment: { ok: false, reason: "missing_required_evidence:external" },
    policy,
    evidenceSummary: { hasFreshEvidence: false },
    userText: "现在最新的美元汇率是多少?",
  });
  check("composer returns null for empty answers", empty === null);
}

if (failures) {
  console.error(`evidence-risk-tiers: ${failures} failure(s)`);
  process.exit(1);
}
console.log("evidence-risk-tiers: ok");
