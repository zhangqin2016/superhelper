#!/usr/bin/env node
// A delivery check continues the answer it checks, as Claude Code's Stop hook
// keeps the model working in the same turn — one answer, never two. Field case
// 2026-09-30: the check superseded the answer (deliverables, sources, tables)
// with a short QA report, and on reload the turn projection brought the
// superseded answer back, so the user saw two answers saying the same thing.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyDocumentDeliveryTurnState, clearDocumentDeliveryTurnState, documentDeliveryDispatchOptions } = require("../src/main/document-delivery-turn.js");
const { buildDocumentDeliveryRecoveryPrompt, isDeliveryCheckPrompt } = require("../src/main/document-delivery-recovery-prompt.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { getConversationPageFromSource } = require("../src/main/opencode-conversation-source.js");

// 1. The link travels with the round, and only with a delivery-check round.
assert.equal(documentDeliveryDispatchOptions({ documentDeliveryRecovery: true, continuesTurnId: "t1" }).continuesTurnId, "t1");
assert.equal(documentDeliveryDispatchOptions({ continuesTurnId: "t1" }).continuesTurnId, "", "no other round continues an answer");
const state = { turnId: "t2", tools: new Map(), timeline: [], notices: [], contentBlocks: [], processEvents: [], assistantText: "已补做视觉检查" };
applyDocumentDeliveryTurnState(state, { documentDeliveryRecovery: true, continuesTurnId: "t1" });
const archive = new TurnArchive({ findById: () => null });
assert.equal(archive.buildRecord(state, "turn.completed", { assistant: state.assistantText }).meta.continuesTurnId, "t1", "the record names the answer it continues");
clearDocumentDeliveryTurnState(state);
assert.equal(state.continuesTurnId, "");
assert.equal(archive.buildRecord(state, "turn.completed", { assistant: "x" }).meta.continuesTurnId, undefined);

// The prompt's own opener identifies a round, in both languages; the reply is only the check.
const zhPrompt = buildDocumentDeliveryRecoveryPrompt({ artifacts: [{ path: "/w/a.docx", ok: false, missing: ["visual_inspection"] }] }, "生成报告");
const enPrompt = buildDocumentDeliveryRecoveryPrompt({ artifacts: [{ path: "/w/a.docx", ok: false, missing: ["visual_inspection"] }] }, "make a report");
assert(isDeliveryCheckPrompt(zhPrompt) && isDeliveryCheckPrompt(enPrompt));
assert(!isDeliveryCheckPrompt("帮我检查一下 [系统] 报告"), "a user's own words are not a check round");
assert(zhPrompt.includes("不要重复原回答的交付清单") && enPrompt.includes("do not repeat the original answer"), "the check reports only what it checked");

// The question is the platform's, never shown as the user's; its answer is kept.
const { isPlatformAuthoredPromptText, internalPromptKind } = require("../src/main/internal-prompt-marker.js");
assert.equal(internalPromptKind(zhPrompt), "recovery", "a new check prompt is tagged where it is built");
const legacyPrompt = "[系统文档交付续检] 这是对刚生成文件的一次内部续接，不是让你从头重做原任务。\n请继续完成当前文档的交付验收。\n待验文件：\n- /w/a.docx";
assert(isPlatformAuthoredPromptText(legacyPrompt), "a check prompt stored before the tag is recognised");
assert(!isPlatformAuthoredPromptText("[系统文档交付续检] 这是对刚生成文件的一次内部续接 —— 这句话是什么意思？"), "a user quoting the opener keeps their message");

// The note appended to an unverified delivery is recorded exactly, so an answer a check continues can drop it.
{
  const { evaluateAnswerEvidence } = require("../src/main/answer-evidence-finalizer.js");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-note-"));
  const pdf = path.join(dir, "r.pdf");
  fs.writeFileSync(pdf, "%PDF-1.7\n%%EOF\n");
  const result = evaluateAnswerEvidence({ assistant: "报告已生成。", artifacts: [{ path: pdf, ext: ".pdf", fileName: "r.pdf", source: "tool_write" }], tools: [], userText: "生成报告" });
  const note = result.assessment.deliveryNote;
  assert(note && result.assistant === `报告已生成。${note}`, "the recorded note is exactly the appended suffix");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. History, on both read paths.
const user = (turnId, content) => ({ id: `u-${turnId}`, role: "user", content, turnId, timestamp: new Date(Date.parse("2026-09-30T01:47:48Z") + turnId.length).toISOString() });
const answer = (turnId, content, meta = {}, at = 0) => ({ id: `a-${turnId}`, role: "assistant", content, turnId, timestamp: new Date(Date.parse("2026-09-30T01:55:00Z") + at).toISOString(),
  record: { turnId, assistantText: content, meta: { terminal: "turn.completed" } }, meta });
const projectedTurn = (turnId, userText, text, at) => [
  { id: `projection:${turnId}:user`, role: "user", content: userText, turnId, timestamp: new Date(Date.parse("2026-09-30T01:47:48Z") + at).toISOString(), meta: { projected: true } },
  { id: `projection:${turnId}:assistant`, role: "assistant", content: text, turnId, timestamp: new Date(Date.parse("2026-09-30T01:55:00Z") + at).toISOString(),
    record: { turnId, assistantText: text, meta: { terminal: "turn.completed" } }, meta: { projected: true } },
];
function ctxFor(host, projections, engine = null) {
  const session = { id: "s1", projectId: "p1", agentResumeId: engine ? "oc_1" : "" };
  return {
    sessionManager: {
      findById: () => session,
      getConversationPageAsync: async () => ({ ok: true, conversation: host.map((m) => ({ ...m })), hasMore: false, total: host.length }),
      getRecentConversationAsync: async () => host.map((m) => ({ ...m })),
      getProjectedConversation: () => projections,
    },
    runnerPool: { get: () => (engine ? { isAlive: () => true, getConversationPage: async () => ({ ok: true, conversation: engine }) } : null) },
  };
}
const visible = (page) => page.conversation.filter((m) => m.role === "assistant").map((m) => `${m.turnId}${m.record?.meta?.continuesTurnId ? `>${m.record.meta.continuesTurnId}` : ""}`);

// a. A delivery check recorded before this change superseded its answer: read as the continuation it was.
{
  const host = [user("t1", "生成个超级复杂的任务"), answer("t1", "已完成。交付物…来源…", { superseded: true, supersededByTurnId: "t2" }), answer("t2", "交付验收完成。", {}, 60_000)];
  const projections = [...projectedTurn("t1", "生成个超级复杂的任务", "已完成。交付物…来源…", 0), ...projectedTurn("t2", legacyPrompt, "交付验收完成。", 60_000)];
  for (const engine of [null, [user("t1", "生成个超级复杂的任务"), { ...answer("t1", "已完成。交付物…来源…"), meta: {} }, { ...answer("t2", "交付验收完成。", {}, 60_000), meta: {} }]]) {
    const page = await getConversationPageFromSource(ctxFor(host, projections, engine), "s1", {});
    assert.notEqual(page.source, "lily-fallback", `the ${engine ? "engine" : "local"} read itself succeeds: ${page.detail || ""}`);
    assert.deepEqual(visible(page), ["t1", "t2>t1"], `${engine ? "engine" : "local"} path: the answer stays and the check continues it`);
    assert(!page.conversation.some((m) => m.role === "user" && String(m.content).includes("系统文档交付续检")), "the check's prompt is not shown as the user's");
  }
}
// b. A real replacement (an evidence retry) stays replaced — its projection no longer brings it back.
{
  const host = [user("t1", "谁是现任 CEO"), answer("t1", "正在等待可靠证据。", { superseded: true, supersededByTurnId: "t3" }), answer("t3", "现任 CEO 是……（来源）", {}, 60_000)];
  const projections = [...projectedTurn("t1", "谁是现任 CEO", "正在等待可靠证据。", 0), ...projectedTurn("t3", "谁是现任 CEO", "现任 CEO 是……（来源）", 60_000)];
  for (const engine of [null, [user("t1", "谁是现任 CEO"), { ...answer("t1", "正在等待可靠证据。"), meta: {} }, { ...answer("t3", "现任 CEO 是……（来源）", {}, 60_000), meta: {} }]]) {
    const page = await getConversationPageFromSource(ctxFor(host, projections, engine), "s1", {});
    assert.notEqual(page.source, "lily-fallback", `the ${engine ? "engine" : "local"} read itself succeeds: ${page.detail || ""}`);
    assert.deepEqual(visible(page), ["t3"], `${engine ? "engine" : "local"} path: a superseded answer stays hidden`);
  }
}
// c. A new check (continuesTurnId recorded, nothing superseded) reads as is.
{
  const check = answer("t2", "已补做视觉检查。", {}, 60_000);
  check.record.meta.continuesTurnId = "t1";
  const host = [user("t1", "生成报告"), answer("t1", "报告已生成。"), check];
  const page = await getConversationPageFromSource(ctxFor(host, [...projectedTurn("t1", "生成报告", "报告已生成。", 0), ...projectedTurn("t2", zhPrompt, "已补做视觉检查。", 60_000)]), "s1", {});
  assert.deepEqual(visible(page), ["t1", "t2>t1"]);
}
console.log("test-delivery-check-continues-answer: ok");
