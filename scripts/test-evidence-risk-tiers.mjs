/**
 * Evidence risk tiers — the "delivered content is never erased" invariant.
 *
 * The gate's job is to prevent fabrication presented as fact, not to prevent
 * answers. These tests pin the tiered contract end-to-end through the REAL
 * evaluateAnswerEvidence pipeline under the 2026-07-20 model-first direction:
 *   - NO tier replaces a good-faith answer anymore (high-stakes fail-closed
 *     is dead). At most one silent auto-verify retry may supersede it.
 *   - First pass with a retry pending: the original is delivered VERBATIM.
 *   - Final state (retry spent): the original + ONE plain-language honesty
 *     note; assessment.deliveredUnverifiedWithNote records it for the
 *     learning loop.
 *   - Salvage still delivers the verified subset + disclosure line when the
 *     unsupported claims are separable (that projection re-passes the gate).
 * Plus: tier classification still drives buffering/retries, Arabic triggers
 * fire, and the kill switch still flattens tiers to hard without ever
 * restoring content replacement.
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
const { normalizeVerificationPlan } = require("../src/main/external-claim-profiles.js");

const HONESTY_NOTE = "备注：以上回答未能通过本轮逐项核实，请以原始来源为准。";

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
  check("advisory answer preserved verbatim", result.assistant === answer,
    `got: ${result.assistant.slice(0, 120)}`);
  check("advisory never triggers forced retry", result.triggerVerifyRetry === false);
}

// ---------------------------------------------------------------------------
console.log("verify_soft: retry pends → verbatim; final state → original + honesty note:");
{
  const text = "现在最新的美元兑人民币汇率是多少?";
  const answer = "美元兑人民币汇率大约在 7.2 左右,近期在 7.1-7.3 区间波动。";
  // First pass: an auto-verify retry is pending → the original is delivered
  // untouched (the retry's verified answer may supersede it).
  const firstPass = runGate(text, answer);
  check("verify_soft triggers auto verify retry", firstPass.triggerVerifyRetry === true);
  check("first pass delivers the original verbatim while retry pends", firstPass.assistant === answer,
    `got: ${firstPass.assistant.slice(0, 160)}`);
  // Final pass (retry already spent): original + ONE plain-language note.
  const finalPass = runGate(text, answer, { recoveryAttempt: true });
  check("final state keeps the original content", finalPass.assistant.includes("7.2"),
    `got: ${finalPass.assistant.slice(0, 160)}`);
  check("final state appends the unverified honesty note", finalPass.assistant === `${answer}\n\n${HONESTY_NOTE}`,
    `got: ${finalPass.assistant.slice(-120)}`);
  check("assessment flags deliveredUnverifiedWithNote", finalPass.assessment?.deliveredUnverifiedWithNote === true);
  check("assessment records riskTier", finalPass.assessment?.riskTier === "verify_soft");
}

// ---------------------------------------------------------------------------
console.log("verify_soft ranking with zero evidence: still delivered, never a zero-content refusal:");
{
  const text = "2026年全球手机销量排行榜前十是哪些?";
  const answer = "第一名是A公司,第二名是B公司,第三名是C公司,完整前十名单如下…";
  const firstPass = runGate(text, answer);
  check("zero-evidence roster is delivered verbatim while retry pends", firstPass.assistant === answer,
    `got: ${firstPass.assistant.slice(0, 160)}`);
  const finalPass = runGate(text, answer, { recoveryAttempt: true });
  check("final state keeps the roster plus the honesty note", finalPass.assistant === `${answer}\n\n${HONESTY_NOTE}`,
    `got: ${finalPass.assistant.slice(-120)}`);
}

// ---------------------------------------------------------------------------
console.log("hard: high-stakes fail-closed is DEAD — the original is always delivered:");
{
  const text = "这个药每天的剂量应该是多少毫克?";
  const answer = "每天服用 500 毫克即可,一日三次。";
  const firstPass = runGate(text, answer);
  check("hard tier no longer replaces the answer", firstPass.assistant === answer,
    `got: ${firstPass.assistant.slice(0, 160)}`);
  check("hard tier still earns a verification retry", firstPass.triggerVerifyRetry === true);
  const finalPass = runGate(text, answer, { recoveryAttempt: true });
  check("hard final state is original + honesty note, not a refusal", finalPass.assistant === `${answer}\n\n${HONESTY_NOTE}`,
    `got: ${finalPass.assistant.slice(-120)}`);
  check("hard final state records deliveredUnverifiedWithNote", finalPass.assessment?.deliveredUnverifiedWithNote === true);
  check("hard final state records riskTier", finalPass.assessment?.riskTier === "hard");
}

// ---------------------------------------------------------------------------
console.log("kill switch flattens tiers but NEVER restores content replacement:");
{
  process.env.LILY_EVIDENCE_RISK_TIERS = "0";
  const text = "现在最新的美元兑人民币汇率是多少?";
  const answer = "美元兑人民币汇率大约在 7.2 左右。";
  check("kill switch: tiers flatten to hard",
    externalFactRiskTier(buildExternalFactPolicy(classifyExternalFactIntent(text))) === "hard");
  const finalPass = runGate(text, answer, { recoveryAttempt: true });
  check("kill switch: the original is still delivered (replacement stays dead)", finalPass.assistant.includes("7.2"),
    `got: ${finalPass.assistant.slice(0, 160)}`);
  check("kill switch: final state still carries the honesty note", finalPass.assistant.endsWith(HONESTY_NOTE));
  check("kill switch: no buffering (legacy streaming)",
    shouldBufferAssistantAnswer(contractFor("这个药的剂量是多少?")) === false);
  delete process.env.LILY_EVIDENCE_RISK_TIERS;
}

// ---------------------------------------------------------------------------
console.log("buffering (verify-before-stream) only where a retry may supersede:");
{
  check("hard tier buffers", shouldBufferAssistantAnswer(contractFor("这个药的剂量是多少?")) === true);
  check("generic verify_soft streams", shouldBufferAssistantAnswer(contractFor("现在最新的美元汇率是多少?")) === false);
  check("researchable ranking streams (can pass the gate)",
    shouldBufferAssistantAnswer(contractFor("2026年全球手机销量排行榜前十")) === false);
  check("no-research ranking buffers (a superseding retry is guaranteed)",
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
  // Judge unavailable → fail open to the deterministic delivery: the original
  // answer verbatim while a verification retry pends (the retry may still
  // supersede it; at the final state the honesty note would be appended).
  const judgeDown = await evaluateAnswerEvidenceWithJudge({
    assistant: answer,
    taskContract: contractFor(text, informalPlan),
    turnPolicy: { taskType: "external_fact" },
    evidenceSummary: { hasFreshEvidence: true, counts: { webSources: 3 } },
    tools: [{ name: "bash", input: { command: "echo q | node resources/skills/websearch/scripts/websearch.cjs" }, result: evidenceText }],
    userText: text,
  }, { judge: async () => null });
  check("judge-down fail-opens to the original answer verbatim", judgeDown.assistant === answer,
    `got: ${judgeDown.assistant.slice(0, 200)}`);
  check("judge-down still earns a verification retry", judgeDown.triggerVerifyRetry === true);
}

if (failures) {
  console.error(`evidence-risk-tiers: ${failures} failure(s)`);
  process.exit(1);
}
console.log("evidence-risk-tiers: ok");
