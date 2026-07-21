#!/usr/bin/env node
/**
 * Unified semantic turn judge (model-first evidence gate).
 * Pins:
 *   - verdict parsing is strict: garbage → null, out-of-range indices ignored
 *   - claims without REAL evidence windows are never judged (fabrication floor)
 *   - judge-accepted claims/sources pass the full deterministic gate on re-run
 *   - judge-rejected / judge-unavailable → the deterministic fail boundary
 *     (ordinary fail-open bounded; conflicts never banner-kept)
 *   - citation repair (deterministic) still precedes the judge
 * Kill switch: LILY_EVIDENCE_LLM_JUDGE=0.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");
const {
  evaluateAnswerEvidence,
  evaluateAnswerEvidenceWithJudge,
} = require("../src/main/answer-evidence-finalizer.js");
const {
  buildSemanticJudgePrompt,
  judgeTurnSemantics,
  parseSemanticVerdict,
  resolveJudgeConnection,
} = require("../src/main/evidence-entailment-judge.js");

const userText = "中国有哪些建筑公司是副部级别";
const contract = buildTaskContract({ text: userText });
// Turn-start detection is domain-blind: "副部级" is not coded anywhere, so the
// detector stays silent. The model declares the semantics via its
// verification-plan candidate (same shape as production refinement).
{
  const { normalizeVerificationPlan } = require("../src/main/external-claim-profiles.js");
  const { buildExternalFactPolicy } = require("../src/main/external-fact-policy.js");
  const { withExternalFactPolicy } = require("../src/main/task-evidence-policy.js");
  const externalFact = buildExternalFactPolicy({
    active: true,
    reasonCodes: ["model_external_fact"],
    requiresFreshness: true,
    requiresSourceLinks: true,
    verificationPlan: normalizeVerificationPlan({
      profileIds: ["model_semantic_claim"],
      claimKinds: ["classification"],
      sourceAuthority: "official_primary",
      entityEvidenceRequired: true,
      classificationEvidenceRequired: true,
    }),
  });
  contract.externalFactPolicy = externalFact;
  contract.evidencePolicy = withExternalFactPolicy(contract.evidencePolicy, externalFact);
}
const govUrl = "https://www.example.gov.cn/notice.html";
const evidenceText = `中国样例建筑集团有限公司主要负责人的任免权限归中央掌握,属重要骨干企业。${govUrl}`;
const answer = ["副部级建筑央企名单:", `1. 中国样例建筑集团有限公司(${govUrl})`].join("\n");

function verdict(overrides = {}) {
  return {
    supportedClaims: [],
    unsupportedClaims: [],
    authoritativeUrls: [],
    conflictingClaims: [],
    informalLabel: false,
    framingNote: "",
    stakes: "low",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Verdict parsing: strict and bounded.
assert.equal(parseSemanticVerdict("not json at all", 2, 1), null);
assert.equal(parseSemanticVerdict('{"claims":[{"claim":1,"supported":true}]}', 1, 0) === null, false);
{
  const parsed = parseSemanticVerdict(
    '{"claims":[{"claim":1,"supported":true},{"claim":2,"supported":false}],"sources":[{"source":1,"authoritative":true}],"conflicts":[2,9],"informalLabel":true,"framingNote":"俗称。","stakes":"high"}',
    2,
    1,
  );
  assert.deepEqual([...parsed.supported], [0]);
  assert.deepEqual([...parsed.authoritative], [0]);
  assert.deepEqual([...parsed.conflicts], [1], "out-of-range conflict indices are dropped");
  assert.equal(parsed.informalLabel, true);
  assert.equal(parsed.framingNote, "俗称。");
  assert.equal(parsed.stakes, "high");
}

// Thinking-model output: reasoning first (itself full of braces), verdict JSON
// LAST, often fenced. The parser must skip reasoning braces and take the final
// verdict candidate — the greedy first-{-to-last-} match never parses this.
{
  const thinking = [
    '先分析 {claim 1}：证据窗口提到任免权限，支持。再看 {claim 2}：{"无关": true} 只是草稿。',
    "权衡来源权威性……",
    "```json",
    '{"claims":[{"claim":1,"supported":true},{"claim":2,"supported":false}],"sources":[],"conflicts":[],"informalLabel":false,"framingNote":"","stakes":"low"}',
    "```",
  ].join("\n");
  const parsed = parseSemanticVerdict(thinking, 2, 0);
  assert(parsed, "verdict JSON after brace-heavy reasoning must parse");
  assert.deepEqual([...parsed.supported], [0]);
  // Truncated output (token budget spent on reasoning) → no candidate → null.
  assert.equal(parseSemanticVerdict('推理中……{"claims":[{"claim":1,"suppo', 1, 0), null);
}

// ---------------------------------------------------------------------------
// judgeTurnSemantics: windowless claims are never sent to the model; transport
// failure → null (caller applies the fail boundary).
{
  let seenPrompt = "";
  const result = await judgeTurnSemantics({
    claims: [
      { label: "有窗实体", windows: ["证据窗口提及有窗实体。"], sentence: "有窗实体符合。" },
      { label: "虚构实体", windows: [], sentence: "虚构实体符合。" },
    ],
    urls: [govUrl],
    userText,
    transport: async ({ prompt }) => {
      seenPrompt = prompt;
      return '{"claims":[{"claim":1,"supported":true}],"sources":[{"source":1,"authoritative":true}],"conflicts":[],"informalLabel":false,"framingNote":"","stakes":"low"}';
    },
  });
  assert.deepEqual(result.supportedClaims, ["有窗实体"]);
  assert(!seenPrompt.includes("虚构实体"), "windowless (fabricated) claims never reach the model");
  assert.deepEqual(result.authoritativeUrls, [govUrl]);
  const failed = await judgeTurnSemantics({
    claims: [{ label: "有窗实体", windows: ["证据窗口提及有窗实体。"], sentence: "" }],
    urls: [],
    userText,
    transport: async () => "garbage",
  });
  assert.equal(failed, null, "malformed judge output degrades to null");
}

// judgeTurnSemantics diagnostics: every null path records WHY (the field
// lesson — a silently-never-running judge took a DB dig to diagnose).
{
  const unparseable = {};
  await judgeTurnSemantics({
    claims: [{ label: "有窗实体", windows: ["证据窗口提及有窗实体。"], sentence: "" }],
    urls: [],
    userText,
    transport: async () => "garbage",
    diagnostics: unparseable,
  });
  assert.equal(unparseable.reason, "verdict_unparseable");

  const empty = {};
  await judgeTurnSemantics({
    claims: [{ label: "有窗实体", windows: ["证据窗口提及有窗实体。"], sentence: "" }],
    urls: [],
    userText,
    transport: async () => "",
    diagnostics: empty,
  });
  assert.equal(empty.reason, "transport_empty");

  const noInput = {};
  await judgeTurnSemantics({ claims: [], urls: [], userText, transport: async () => "{}", diagnostics: noInput });
  assert.equal(noInput.reason, "no_judgable_input");
}

// resolveJudgeConnection: the preset's compatibility overlay (disable-thinking
// chat_template_kwargs) rides the judge connection — thinking-disabled
// gateways answer in seconds instead of burning the timeout on reasoning.
{
  const modelPresets = require("../src/main/model-presets.js");
  const originalGetActivePreset = modelPresets.getActivePreset;
  const originalGetActivePresetEnv = modelPresets.getActivePresetEnv;
  modelPresets.getActivePreset = () => ({ id: "test-managed", custom: false, model: "test-model" });
  modelPresets.getActivePresetEnv = () => ({
    LILY_API_BASE_URL: "https://gateway.example.test/llm/test/v1",
    LILY_API_KEY: "test-key",
    LILY_MODEL: "test-model",
    LILY_OPENCODE_BODY_OVERLAY_JSON: '{"chat_template_kwargs":{"enable_thinking":false}}',
  });
  try {
    const connection = resolveJudgeConnection();
    assert.equal(connection.model, "test-model");
    assert.deepEqual(connection.bodyOverlay, { chat_template_kwargs: { enable_thinking: false } });
  } finally {
    modelPresets.getActivePreset = originalGetActivePreset;
    modelPresets.getActivePresetEnv = originalGetActivePresetEnv;
  }
  // A malformed overlay never breaks resolution.
  modelPresets.getActivePreset = () => ({ id: "test-managed", custom: false, model: "test-model" });
  modelPresets.getActivePresetEnv = () => ({
    LILY_API_BASE_URL: "https://gateway.example.test/llm/test/v1",
    LILY_API_KEY: "test-key",
    LILY_MODEL: "test-model",
    LILY_OPENCODE_BODY_OVERLAY_JSON: "{broken",
  });
  try {
    const connection = resolveJudgeConnection();
    assert(connection, "malformed overlay must not break connection resolution");
    assert.equal(connection.bodyOverlay, null);
  } finally {
    modelPresets.getActivePreset = originalGetActivePreset;
    modelPresets.getActivePresetEnv = originalGetActivePresetEnv;
  }
}

// The prompt quotes only real windows and forbids outside knowledge for claims.
{
  const prompt = buildSemanticJudgePrompt({
    userText,
    claims: [{ label: "中国样例建筑集团有限公司", windows: [evidenceText.slice(0, 200)], sentence: answer }],
    urls: [govUrl],
  });
  assert.match(prompt, /Do not use any outside knowledge/);
  assert.match(prompt, /任免权限归中央掌握/);
  assert.match(prompt, /informalLabel/);
  assert.match(prompt, /stakes/);
}

// ---------------------------------------------------------------------------
// Flow through evaluateAnswerEvidenceWithJudge.
const params = {
  assistant: answer,
  taskContract: contract,
  turnPolicy: buildTurnPolicy({ text: userText, taskContract: contract }),
  evidenceSummary: { hasFreshEvidence: true, counts: { webSources: 2 }, events: [{ kind: "web_fetch" }] },
  tools: [{ name: "bash", input: { command: "echo q | node resources/skills/websearch/scripts/websearch.cjs" }, result: evidenceText }],
  userText,
};

// Deterministic pass: authority adequacy is the first stage PENDING the judge
// (publisher identity is a semantic ruling, no longer a gov-TLD regex).
const det = evaluateAnswerEvidence(params);
assert.equal(det.assessment.reason, "authoritative_source_required");
assert.equal(det.assessment.authorityPending, true);
assert(det.assistant.includes("中国样例建筑集团"), "pending content is bounded, not erased");

// Judge supports (and rules the label informal) → full pass WITH framing note.
const judged = await evaluateAnswerEvidenceWithJudge(params, {
  judge: async ({ urls }) => verdict({
    supportedClaims: ["中国样例建筑集团有限公司"],
    authoritativeUrls: urls,
    informalLabel: true,
    framingNote: "副部级是行业俗称,并非官方正式认定。",
  }),
});
assert.equal(judged.assessment.ok, true);
assert(judged.assistant.includes("中国样例建筑集团"), "judge-accepted claim delivers the original answer");
assert.match(judged.assistant, /口径说明/, "informal label carries the framing note even on pass");
assert.deepEqual(judged.assessment.judgeAcceptedClaims, ["中国样例建筑集团有限公司"]);

// Judge rejects support → ordinary fail-open: bounded banner, content kept.
const rejected = await evaluateAnswerEvidenceWithJudge(params, {
  judge: async () => verdict({ unsupportedClaims: ["中国样例建筑集团有限公司"] }),
});
assert.equal(rejected.assessment.ok, false);
assert(rejected.assistant.includes("中国样例建筑集团"), "windowed-but-unproven claims stay under a banner");
assert.match(rejected.assistant, /⚠️/);

// Judge crashes/unavailable → the deterministic (bounded) verdict stands.
const crashed = await evaluateAnswerEvidenceWithJudge(params, {
  judge: async () => { throw new Error("boom"); },
});
assert.equal(crashed.assistant, det.assistant);

// Judge-ruled conflict → never banner-kept.
const conflicted = await evaluateAnswerEvidenceWithJudge(params, {
  judge: async () => verdict({ conflictingClaims: ["中国样例建筑集团有限公司"] }),
});
assert(!conflicted.assistant.includes("中国样例建筑集团"), "conflicts are never banner-kept");

// Kill switch disables the judge entirely.
process.env.LILY_EVIDENCE_LLM_JUDGE = "0";
const killed = await evaluateAnswerEvidenceWithJudge(params, {
  judge: async () => verdict({ supportedClaims: ["中国样例建筑集团有限公司"] }),
});
assert.equal(killed.assistant, det.assistant);
assert.equal(killed.assessment.ok, false);
delete process.env.LILY_EVIDENCE_LLM_JUDGE;

// ---------------------------------------------------------------------------
// Citation repair (deterministic) still runs BEFORE the judge — a citation-
// discipline failure must not destroy real research.
{
  const govUrl2 = "https://wap.sasac.gov.cn/n2588025/n2588139/c2820992/content.html";
  const ledgerEvidence = `国资委央企名录 中国建筑集团有限公司排名第47位。前54家中管企业主要负责人由中共中央组织部任免。${govUrl2}`;
  const acceptAll = async ({ urls }) => verdict({
    supportedClaims: ["中国建筑集团有限公司"],
    authoritativeUrls: urls,
    informalLabel: true,
    framingNote: "副部级是行业对中管企业的俗称。",
  });
  const mk = (assistantText, { emptyLedger = false, recoveryAttempt = true } = {}) => ({
    assistant: assistantText,
    recoveryAttempt,
    taskContract: contract,
    turnPolicy: buildTurnPolicy({ text: userText, taskContract: contract }),
    evidenceSummary: emptyLedger
      ? { hasFreshEvidence: false, counts: {}, events: [] }
      : { hasFreshEvidence: true, counts: { webSources: 4 }, events: [{ kind: "web_fetch", query: govUrl2 }] },
    tools: emptyLedger
      ? []
      : [{ name: "bash", input: { command: "echo q | node resources/skills/websearch/scripts/websearch.cjs" }, result: ledgerEvidence }],
    userText,
  });
  const noCite = ["前提:副部级是行业对中管企业的俗称。", "中管建筑央企名单:", "1. 中国建筑集团有限公司(央企名录第47位,由中组部任免主要负责人)"].join("\n");
  assert.equal(evaluateAnswerEvidence(mk(noCite)).assessment.reason, "external_fact_without_source_link");
  const firstPass = await evaluateAnswerEvidenceWithJudge(mk(noCite, { recoveryAttempt: false }), { judge: acceptAll });
  assert.equal(firstPass.triggerVerifyRetry, true, "first pass keeps the auto-verify retry");
  assert.notEqual(firstPass.assessment.citationRepaired, true);
  const repairedA = await evaluateAnswerEvidenceWithJudge(mk(noCite), { judge: acceptAll });
  assert.equal(repairedA.assessment.ok, true, "missing citations repaired from the ledger, then judge clears the rest");
  assert(repairedA.assistant.includes("第47位"));
  assert(repairedA.assistant.includes("本轮检索来源"));
  assert.equal(repairedA.assessment.citationRepaired, true);

  const fakeCite = `中管建筑央企:中国建筑集团有限公司(https://baike.fake-site.com/entry/123)。`;
  const repairedB = await evaluateAnswerEvidenceWithJudge(mk(fakeCite), { judge: acceptAll });
  assert(!repairedB.assistant.includes("fake-site"), "fabricated urls are stripped, never delivered");
  assert(repairedB.assistant.includes("中国建筑集团"));
  assert.deepEqual(repairedB.assessment.citationStrippedUrls, ["https://baike.fake-site.com/entry/123"]);

  const emptyLedger = await evaluateAnswerEvidenceWithJudge(mk(noCite, { emptyLedger: true }), { judge: acceptAll });
  assert(!emptyLedger.assistant.includes("第47位"), "empty ledger stays gated — nothing honest to repair or keep");

  process.env.LILY_EVIDENCE_CITATION_REPAIR = "0";
  const repairKilled = await evaluateAnswerEvidenceWithJudge(mk(noCite), { judge: acceptAll });
  assert(repairKilled.assistant.includes("第47位"), "with repair disabled the fail-open banner still keeps the researched content");
  delete process.env.LILY_EVIDENCE_CITATION_REPAIR;
}

console.log("evidence-entailment-judge: ok");
