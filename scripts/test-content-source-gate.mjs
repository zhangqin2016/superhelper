#!/usr/bin/env node
// A folder/workspace question must never be answered with the canned "I could
// not read the attachment" line (2026-09-15 demo bug: Lily analysed a folder,
// wrote the result to output/, then told the user it had no access).
// Two layers: 文件夹/目录 is not a document mention, and a content_extraction
// turn with nothing attached requires a real file read instead of
// attachment-only source_content evidence — so the answer is never replaced.
// [gate: attachment-content-grounding]
// Run: node scripts/test-content-source-gate.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inferContentTaskIntent } = require("../src/main/content-task-intent.js");
const { buildEvidencePolicy, hasExtractableContentSource } = require("../src/main/task-evidence-policy.js");
const { evaluateAnswerEvidence, shouldBufferAssistantAnswer } = require("../src/main/answer-evidence-finalizer.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

const REAL_ANSWER = "这个目录下有 12 个文件：3 个配置、7 个脚本、2 个文档。脚本里 build.sh 会调用 npm run dist。";
const CANNED = /我还没有成功读取这份图片或文档的实际内容/;

check("a folder question is no longer classified as document extraction; a real document still is", () => {
  const folder = ["告诉我这个文件夹里的内容，分析一下", "分析这个文件夹里都有什么内容", "看看这个文件目录里的内容"];
  for (const text of folder) {
    assert.equal(inferContentTaskIntent({ text, files: [] }).routeTaskType, "", text);
  }
  assert.equal(inferContentTaskIntent({ text: "帮我看看这个文档的内容", files: [] }).routeTaskType, "content_extraction");
  assert.equal(inferContentTaskIntent({ text: "分析这个文件的内容", files: [] }).routeTaskType, "content_extraction");
  // An attached folder-named file is still a document.
  assert.equal(inferContentTaskIntent({ text: "分析一下这个文件夹报告", files: [{ name: "a.docx" }] }).routeTaskType, "content_extraction");
});

check("content_extraction demands attachment evidence only when something can actually be extracted", () => {
  const base = { active: true, taskType: "content_extraction" };
  const none = { ...base, contentIntent: { attachmentKinds: [] } };
  const attached = { ...base, contentIntent: { attachmentKinds: ["document"] } };
  const inherited = { ...base, contentIntent: { attachmentKinds: [] }, priorSourceContentEvidence: { sourceCount: 1 } };
  assert.deepEqual(buildEvidencePolicy(none).requiredEvidenceKinds, ["file_read"]);
  assert.deepEqual(buildEvidencePolicy(attached).requiredEvidenceKinds, ["source_content"]);
  assert.deepEqual(buildEvidencePolicy(inherited).requiredEvidenceKinds, ["source_content"], "a prior turn's source is still a source");
  assert.equal(hasExtractableContentSource(none), false);
  assert.equal(hasExtractableContentSource(attached), true);
  assert.equal(hasExtractableContentSource(inherited), true);
  assert.equal(hasExtractableContentSource({}), false);
});

check("the stream is only buffered when a source-content verdict can actually fire", () => {
  assert.equal(shouldBufferAssistantAnswer({ taskType: "content_extraction", contentIntent: { attachmentKinds: [] } }), false);
  assert.equal(shouldBufferAssistantAnswer({ taskType: "content_extraction", contentIntent: { attachmentKinds: ["image"] } }), true);
  assert.equal(shouldBufferAssistantAnswer(null), false);
});

check("a tool-grounded folder answer survives the gate; an unread ATTACHMENT is still refused", () => {
  const readEvidence = {
    hasFileReadEvidence: true, hasToolEvidence: true, hasSourceContentEvidence: false,
    counts: { filesRead: 12, tools: 14 }, sourceContentCoverage: { status: "unavailable", sourceCount: 0, observedCount: 0 },
  };
  const contractFor = (attachmentKinds) => {
    const classification = { active: true, taskType: "content_extraction", contentIntent: { attachmentKinds } };
    return { ...classification, evidencePolicy: buildEvidencePolicy(classification) };
  };
  const folderContract = contractFor([]);
  assert.deepEqual(folderContract.evidencePolicy.requiredEvidenceKinds, ["file_read"]);
  const folderTurn = {
    assistant: REAL_ANSWER, userText: "告诉我这个文件夹里的内容",
    taskContract: folderContract,
    turnPolicy: { rigor: "grounded", taskType: "content_extraction" },
    evidenceSummary: readEvidence,
    tools: [{ name: "read", status: "done" }, { name: "list", status: "done" }],
  };
  const kept = evaluateAnswerEvidence(folderTurn);
  assert.equal(kept.assistant.includes(REAL_ANSWER), true, "the real analysis must be delivered");
  assert.doesNotMatch(kept.assistant, CANNED);

  assert.equal(kept.assessment.ok, true, "a folder read satisfies the file_read requirement");

  // The anti-confabulation guard must still hold for a real, unread attachment.
  const attachedContract = contractFor(["document"]);
  assert.deepEqual(attachedContract.evidencePolicy.requiredEvidenceKinds, ["source_content"]);
  const refused = evaluateAnswerEvidence({
    ...folderTurn,
    assistant: "这份文档写明了三条违约条款。",
    userText: "分析这个文档的内容",
    taskContract: attachedContract,
    inputFiles: [{ name: "case.docx" }],
    evidenceSummary: { ...readEvidence, counts: { ...readEvidence.counts, sourceContentSources: 1 }, sourceContentCoverage: { status: "unavailable", sourceCount: 1, observedCount: 0 } },
  });
  assert.equal(refused.assessment.reason, "missing_required_evidence:source_content");
  assert.match(refused.assistant, CANNED, "an attachment that was never read still must not be guessed at");
});

check("an operation refused by the permission mode says so instead of reaching the model as an unexplained failure", () => {
  const { describePermissionDenial, permissionAutoDeniedNotice } = require("../src/main/permission-denial-copy.js");
  assert.match(describePermissionDenial({ toolName: "external_directory", mode: "plan", locale: "zh-CN" }), /仅规划/);
  assert.match(describePermissionDenial({ toolName: "external_directory", mode: "plan", locale: "zh-CN" }), /工作区之外的目录/);
  assert.match(describePermissionDenial({ toolName: "bash", mode: "ask", nonInteractive: true, locale: "zh-CN" }), /自动执行/);
  assert.match(describePermissionDenial({ toolName: "unknown_tool", mode: "ask", locale: "zh-CN" }), /这个操作/);
  for (const locale of ["zh-CN", "en", "ar"]) {
    assert.ok(describePermissionDenial({ toolName: "external_directory", mode: "plan", locale }).length > 8, locale);
  }
  const notice = permissionAutoDeniedNotice({ toolName: "external_directory", mode: "plan", locale: "zh-CN" });
  assert.equal(notice.type, "engine.notice");
  assert.equal(notice.payload.notice.code, "permissionAutoDenied");
  assert.equal(notice.payload.notice.replacesCode, "permissionAutoDenied", "repeated refusals collapse into one chip");
  const session = fs.readFileSync(new URL("../src/main/opencode-agent-session.js", import.meta.url), "utf8");
  const deny = session.slice(session.indexOf('if (verdict === "deny")'), session.indexOf('if (verdict === "deny")') + 400);
  assert.ok(deny.indexOf("_autoRespondPermission") < deny.indexOf("permissionAutoDeniedNotice"),
    "the engine's request is answered first; a future throw in the notice must never leave it hanging");
});

console.log(`\n${checks} checks passed (content source gate)`);
