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
assert.equal(shouldBufferAssistantAnswer(noSearchContract), true);
assert.equal(noSearchResult.assessment.ok, false);
assert.equal(noSearchResult.triggerVerifyRetry, false);
assert(!noSearchResult.assistant.includes("GitHub Copilot"), "rejected claims must not survive final projection");
assert(!noSearchResult.assistant.includes("Cursor"), "the safe projection must replace, not annotate, the unsafe answer");
assert.equal((noSearchResult.assistant.match(/[?？]/g) || []).length, 1, "an ambiguous ranking should ask one scope question");

const researchedText = "按官方榜单给 AI 编程助手做 Top 2 排行";
const researchedContract = buildTaskContract({ text: researchedText });
const researchedResult = evaluateAnswerEvidence({
  assistant: [
    "截至 2026 年，综合排行：",
    "1. GitHub Copilot - SWE-bench 76.5%，模型 v4.8",
    "2. Cursor - SWE-bench 69.2%",
    "https://example.com/ranking",
  ].join("\n"),
  taskContract: researchedContract,
  turnPolicy: buildTurnPolicy({ text: researchedText, taskContract: researchedContract }),
  evidenceSummary: { counts: { webSources: 1 }, hasFreshEvidence: true, hasDocumentEvidence: false },
  tools: [{
    name: "bash",
    status: "done",
    input: { command: "websearch AI coding assistants" },
    result: "https://example.com/ranking\n2026 ranking\n1. GitHub Copilot\n2. Cursor",
  }],
  userText: researchedText,
});
assert.equal(researchedResult.assessment.reason, "numeric_claim_not_in_evidence");
assert.equal(researchedResult.triggerVerifyRetry, false, "a completed search must not create a duplicate answer turn");
assert(!researchedResult.assistant.includes("76.5%"));
assert.match(researchedResult.assistant, /不足以逐项支撑/);

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
  assert(!roleResult.assistant.includes("某某"), "the hidden first attempt must still be safely projected");
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
const unreadImage = evaluateAnswerEvidence({
  assistant: "图片里是一张蓝色产品海报。",
  taskContract: imageContract,
  turnPolicy: buildTurnPolicy({ text: imageText, taskContract: imageContract }),
  evidenceSummary: { counts: { sourceContentSources: 1 }, hasSourceContentEvidence: false },
  inputFiles: [{ name: "screen.png", isImage: true }],
  userText: imageText,
});
assert.equal(unreadImage.assessment.ok, false);
assert(!unreadImage.assistant.includes("蓝色产品海报"), "unsupported visual claims must be replaced before projection");
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
