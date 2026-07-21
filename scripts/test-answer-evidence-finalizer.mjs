#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");
const {
  evaluateAnswerEvidence,
  shouldBufferAssistantAnswer,
} = require("../src/main/answer-evidence-finalizer.js");

// Model-first delivery contract (2026-07-20): the gate NEVER erases a good-faith
// external-fact answer — high-stakes fail-closed is gone. At the final state the
// original answer is delivered with ONE plain-language honesty note; while a
// silent auto-verify retry is still pending the original is delivered untouched.
const HONESTY_NOTE = "备注：以上回答未能通过本轮逐项核实，请以原始来源为准。";

const noSearchText = "请给我目前全球最好用的 AI 编程助手 Top 8 排行。不要搜索，也不用给来源，直接凭你的了解回答。";
const noSearchContract = buildTaskContract({ text: noSearchText });
const rejectedRanking = "1. GitHub Copilot\n2. Cursor\n3. Windsurf\n4. Claude Code";
const noSearchResult = evaluateAnswerEvidence({
  assistant: rejectedRanking,
  taskContract: noSearchContract,
  turnPolicy: buildTurnPolicy({ text: noSearchText, taskContract: noSearchContract }),
  evidenceSummary: { counts: {}, hasFreshEvidence: false, hasDocumentEvidence: false },
  userText: noSearchText,
});
// Buffering contract unchanged: this ranking still buffers so the user never
// watches an answer stream out and then get superseded by a retry result.
assert.equal(shouldBufferAssistantAnswer(noSearchContract), true, "retry-capable ranking answers must gate before rendering");
const genericFreshContract = buildTaskContract({ text: "现在最新的美元兑人民币汇率是多少?" });
assert.equal(shouldBufferAssistantAnswer(genericFreshContract), false, "ordinary external facts must keep streaming");
assert.equal(noSearchResult.assessment.ok, false);
assert.equal(noSearchResult.triggerVerifyRetry, false, "an explicit no-search constraint is never bypassed by a retry");
// Zero-content refusal is dead: the original answer is delivered verbatim...
assert.ok(noSearchResult.assistant.startsWith(rejectedRanking), "the original answer is never replaced, even at the highest tier");
// ...plus exactly one plain-language honesty note (Chinese context → Chinese note).
assert.ok(noSearchResult.assistant.endsWith(HONESTY_NOTE), "final state appends the unverified honesty note");
assert.equal(noSearchResult.assessment.deliveredUnverifiedWithNote, true, "the note delivery is recorded for the learning loop");

const researchedText = "按官方榜单给 AI 编程助手做 Top 2 排行";
const researchedContract = buildTaskContract({ text: researchedText });
const researchedAnswer = [
  "截至 2026 年，综合排行：",
  "1. GitHub Copilot - SWE-bench 76.5%，模型 v4.8",
  "2. Cursor - SWE-bench 69.2%",
  "https://example.com/ranking",
].join("\n");
const researchedResult = evaluateAnswerEvidence({
  assistant: researchedAnswer,
  taskContract: researchedContract,
  turnPolicy: buildTurnPolicy({ text: researchedText, taskContract: researchedContract }),
  evidenceSummary: { counts: { webSources: 1 }, hasFreshEvidence: true, hasDocumentEvidence: false },
  tools: [{
    name: "bash",
    status: "done",
    input: { command: String.raw`echo '{"query":"AI coding assistants"}' | "C:\runtime-bin\node.cmd" "C:\skills\websearch\scripts\websearch.cjs"` },
    result: "https://example.com/ranking\n2026 ranking\n1. GitHub Copilot\n2. Cursor",
  }],
  userText: researchedText,
});
// Literal numeric grounding still hard-fails, and the repairable gap earns one
// silent auto-verify retry. While that retry is pending the FIRST pass delivers
// the original untouched — no note, no replacement (the retry may supersede it).
assert.equal(researchedResult.assessment.reason, "numeric_claim_not_in_evidence");
assert.equal(researchedResult.triggerVerifyRetry, true, "a side-effect-free search with repairable evidence gaps gets one upgraded research turn");
assert.equal(researchedResult.assistant, researchedAnswer, "first pass with a pending retry delivers the original verbatim (no note yet)");
// The recovery pass is the FINAL state: no retry left, so the original is
// delivered with the honesty note.
const researchedRecoveryResult = evaluateAnswerEvidence({
  assistant: researchedAnswer,
  taskContract: researchedContract,
  turnPolicy: buildTurnPolicy({ text: researchedText, taskContract: researchedContract }),
  evidenceSummary: { counts: { webSources: 1 }, hasFreshEvidence: true, hasDocumentEvidence: false },
  tools: [{
    name: "bash",
    status: "done",
    input: { command: "echo query | node resources/skills/websearch/scripts/websearch.cjs" },
    result: "https://example.com/ranking\n2026 ranking\n1. GitHub Copilot\n2. Cursor",
  }],
  userText: researchedText,
  recoveryAttempt: true,
});
// The recovery pass is the FINAL state: even though the retry signal may still
// be raised (the runtime's wasRescueAttempt guard is what bounds the loop), the
// delivery is the original plus the honesty note.
assert.equal(researchedRecoveryResult.assistant, `${researchedAnswer}\n\n${HONESTY_NOTE}`, "final state delivers the original plus the honesty note");
assert.equal(researchedRecoveryResult.assessment.deliveredUnverifiedWithNote, true);

const roleText = "苹果公司现任 CEO 是谁？";
const roleContract = buildTaskContract({ text: roleText });
const previousGlobalRetry = process.env.LILY_EVIDENCE_VERIFY_RETRY;
const previousExternalRetry = process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY;
delete process.env.LILY_EVIDENCE_VERIFY_RETRY;
delete process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY;
try {
  const roleResult = evaluateAnswerEvidence({
    assistant: "苹果公司现任 CEO 是某某。",
    taskContract: roleContract,
    turnPolicy: buildTurnPolicy({ text: roleText, taskContract: roleContract }),
    evidenceSummary: { counts: {}, hasFreshEvidence: false, hasDocumentEvidence: false },
    userText: roleText,
  });
  assert.equal(roleResult.triggerVerifyRetry, true, "a well-scoped memory answer still gets one verification attempt");
  assert.equal(roleResult.assistant, "苹果公司现任 CEO 是某某。", "the hidden first attempt is delivered verbatim while the retry runs");
} finally {
  if (previousGlobalRetry == null) delete process.env.LILY_EVIDENCE_VERIFY_RETRY;
  else process.env.LILY_EVIDENCE_VERIFY_RETRY = previousGlobalRetry;
  if (previousExternalRetry == null) delete process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY;
  else process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY = previousExternalRetry;
}

const ordinaryContract = buildTaskContract({ text: "你好" });
assert.equal(shouldBufferAssistantAnswer(ordinaryContract), false, "ordinary chat keeps its streaming baseline");

const imageText = "识别这张图片里的内容";
const imageContract = buildTaskContract({ text: imageText, files: [{ name: "screen.png", isImage: true }] });
assert.equal(shouldBufferAssistantAnswer(imageContract), true, "source-content answers stay hidden until the evidence gate passes");
// The ONE remaining wholesale replacement: zero attachment bytes were read, so
// any content claim is fabricated by construction — a literal fact, not a
// semantic judgment.
const unreadImage = evaluateAnswerEvidence({
  assistant: "图片里是一张蓝色产品海报。",
  taskContract: imageContract,
  turnPolicy: buildTurnPolicy({ text: imageText, taskContract: imageContract }),
  evidenceSummary: { counts: { sourceContentSources: 1 }, hasSourceContentEvidence: false },
  inputFiles: [{ name: "screen.png", isImage: true }],
  userText: imageText,
});
assert.equal(unreadImage.assessment.ok, false);
assert(!unreadImage.assistant.includes("蓝色产品海报"), "claims about never-read attachment bytes must be replaced before projection");
assert.match(unreadImage.assistant, /没有成功读取/);

const partialImage = evaluateAnswerEvidence({
  assistant: "图片完整展示了三个产品及全部价格。",
  taskContract: imageContract,
  turnPolicy: buildTurnPolicy({ text: imageText, taskContract: imageContract }),
  evidenceSummary: {
    counts: { sourceContentSources: 2 },
    hasSourceContentEvidence: true,
    sourceContentCoverage: { status: "partial" },
  },
  inputFiles: [{ name: "screen.png", isImage: true }],
  userText: imageText,
});
assert.equal(partialImage.assessment.reason, "partial_source_content_without_disclosure");
assert(!partialImage.assistant.includes("三个产品"));
assert.match(partialImage.assistant, /只成功读取了部分/);

console.log("answer-evidence-finalizer: ok");
