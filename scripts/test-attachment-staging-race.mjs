#!/usr/bin/env node
// Dropping a Word file and pressing Enter immediately used to send the message
// with NO attachment and no warning — the whole "Word 拖拽时好时坏" report.
// Staging is now bracketed by the file handler and awaited by the composer, the
// wait is bounded, a drag that carries no disk path gets drag-specific copy, and
// a failed document extraction reports the extractor's real reason instead of an
// opaque "Command failed". [gate: attachment-content-grounding]
// Run: node scripts/test-attachment-staging-race.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import {
  attachmentStagingInFlight, resetAttachmentStagingForTests, setAttachmentStagingListener,
  trackAttachmentStaging, whenAttachmentsSettled,
} from "../src/renderer/modules/attachment-staging.js";

const require = createRequire(import.meta.url);
let checks = 0;
async function check(name, fn) { resetAttachmentStagingForTests(); await fn(); checks += 1; console.log(`ok - ${name}`); }

await check("a send that races a drop waits for staging, and concurrent stages all settle before it resumes", async () => {
  assert.equal(attachmentStagingInFlight(), false);
  assert.equal(await whenAttachmentsSettled(), true, "nothing staging → resolves immediately");
  const staged = [];
  let releaseA; let releaseB;
  const a = trackAttachmentStaging(async () => { await new Promise((r) => { releaseA = r; }); staged.push("a"); });
  const b = trackAttachmentStaging(async () => { await new Promise((r) => { releaseB = r; }); staged.push("b"); });
  assert.equal(attachmentStagingInFlight(), true);
  let sent = false;
  const send = whenAttachmentsSettled().then((ok) => { sent = ok; return staged.slice(); });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent, false, "the send must not proceed while a file is still being staged");
  releaseA(); await a;
  assert.equal(attachmentStagingInFlight(), true, "one of two stages finishing is not enough");
  releaseB(); await b;
  assert.deepEqual(await send, ["a", "b"], "the send sees every attachment");
  assert.equal(sent, true);
  assert.equal(attachmentStagingInFlight(), false);
});

await check("a staging run that throws still releases the send, and the wait is bounded", async () => {
  await assert.rejects(trackAttachmentStaging(async () => { throw new Error("stage exploded"); }), /stage exploded/);
  assert.equal(attachmentStagingInFlight(), false, "a failed stage must never wedge the composer");
  let fired = null;
  const stuck = trackAttachmentStaging(() => new Promise(() => {}));
  const timedOut = await whenAttachmentsSettled({ timeoutMs: 0, setTimeoutImpl: (fn) => { fn(); return 1; }, clearTimeoutImpl: () => { fired = "cleared"; } });
  assert.equal(timedOut, false, "a stuck stage degrades to sending without it, never a frozen composer");
  assert.equal(fired, null);
  void stuck;
});

await check("the send button is told when staging starts and stops", async () => {
  const seen = [];
  setAttachmentStagingListener((busy) => seen.push(busy));
  await trackAttachmentStaging(async () => { await Promise.resolve(); });
  assert.deepEqual(seen, [true, false]);
  setAttachmentStagingListener(() => { throw new Error("listener blew up"); });
  await trackAttachmentStaging(async () => "ok");
  assert.equal(attachmentStagingInFlight(), false, "a throwing listener never breaks staging");
});

await check("every attachment entry point is bracketed and the composer waits before snapshotting files", async () => {
  const handler = fs.readFileSync(new URL("../src/renderer/modules/file-handler.js", import.meta.url), "utf8");
  assert.equal((handler.match(/trackAttachmentStaging\(\(\) => routeBrowserDrop\(dtFiles\)\)/g) || []).length, 2, "both drop handlers");
  assert.match(handler, /document\.addEventListener\("paste", \(e\) => trackAttachmentStaging\(async \(e?\)?/);
  assert.match(handler, /error: "DRAG_FILE_TOO_LARGE"/);
  const composer = fs.readFileSync(new URL("../src/renderer/modules/composer.js", import.meta.url), "utf8");
  const send = composer.slice(composer.indexOf("export async function sendPrompt"));
  const wait = send.indexOf("whenAttachmentsSettled()");
  const snapshot = send.indexOf('store.get("pendingFiles")');
  assert.ok(wait > 0 && wait < snapshot, "the wait must come BEFORE the attachment list is read");
  assert.match(composer, /trackAttachmentStaging\(async \(\) => \{\n    const result = await window\.assistantClient\.pickFiles/);
  assert.match(composer, /setAttachmentStagingListener/);
  for (const locale of ["zh-CN", "en", "ar"]) {
    const json = JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    assert.ok(json["toast.attachmentStaging"], `${locale} staging toast`);
    assert.ok(json["fileErrors.DRAG_FILE_TOO_LARGE"], `${locale} drag-too-large copy`);
    assert.notEqual(json["fileErrors.DRAG_FILE_TOO_LARGE"], json["fileErrors.FILE_TOO_LARGE"], "a drag is not a paste");
  }
});

await check("a failed document extraction reports the extractor's own reason, and a timeout says so", async () => {
  const { classifyExtractionResult } = require("../src/main/document-translator.js");
  // The extractor prints its reason on stdout and THEN exits non-zero.
  assert.deepEqual(classifyExtractionResult({ message: "Command failed" }, JSON.stringify({ ok: false, error: "password protected" })),
    { error: "EXTRACT_FAILED:password protected" }, "the real cause must survive a non-zero exit");
  assert.deepEqual(classifyExtractionResult(Object.assign(new Error("timed out"), { killed: true }), "", 180000),
    { error: "EXTRACT_TIMEOUT:180000ms" });
  assert.deepEqual(classifyExtractionResult({ message: "spawn ENOENT" }, ""), { error: "EXTRACT_FAILED:spawn ENOENT" });
  assert.deepEqual(classifyExtractionResult(null, "not json"), { error: "EXTRACT_BAD_OUTPUT" });
  // Success carries the extracted text; other fields (e.g. embedded images) may
  // be added by the extractor without weakening the failure contract above.
  const ok = classifyExtractionResult(null, JSON.stringify({ ok: true, text: "hello" }));
  assert.equal(ok.error, undefined);
  assert.equal(ok.text, "hello");
  const src = fs.readFileSync(new URL("../src/main/document-translator.js", import.meta.url), "utf8");
  assert.ok(src.includes("classifyExtractionResult(err, stdout, PYTHON_EXTRACT_TIMEOUT_MS)"), "the exec callback delegates to the tested classifier");
});

await check("a document that cannot be read says WHY, in the user's language, and routing never discards it", async () => {
  const { describeDocumentFailure, describeDocumentFailures } = require("../src/main/document-failure-copy.js");
  assert.match(describeDocumentFailure("LEGACY_FORMAT:.doc", "zh-CN"), /旧版 \.doc/);
  assert.match(describeDocumentFailure("RUNTIME_UNAVAILABLE", "zh-CN"), /解析组件未就绪/);
  assert.match(describeDocumentFailure("EXTRACT_TIMEOUT:180000ms", "zh-CN"), /超时/);
  assert.match(describeDocumentFailure("EXTRACT_FAILED:password protected", "zh-CN"), /password protected/);
  for (const locale of ["zh-CN", "en", "ar"]) {
    assert.ok(describeDocumentFailure("RUNTIME_UNAVAILABLE", locale).length > 4, locale);
  }
  assert.equal(describeDocumentFailures([{ error: "RUNTIME_UNAVAILABLE" }, { error: "RUNTIME_UNAVAILABLE" }], "zh-CN"),
    describeDocumentFailure("RUNTIME_UNAVAILABLE", "zh-CN"), "one reason is stated once");
  assert.equal(describeDocumentFailures([], "zh-CN"), "");
  const preflight = fs.readFileSync(new URL("../src/main/send-preflight.js", import.meta.url), "utf8");
  assert.equal((preflight.match(/detail: documentFailureDetail\(result\.failures\)/g) || []).length, 2,
    "both documentSkipped notices carry the reason");
  assert.match(preflight, /extractedContext/);
  // Routing (authoring / web-system learning) replaces the user text; the
  // extraction must ride along instead of being dropped with it.
  const { applyPreflightContexts } = require("../src/main/turn-preflight-context.js");
  const composed = applyPreflightContexts("ROUTED INSTRUCTION", [{ label: "Document extraction result", content: "CONTRACT CLAUSE 7" }]);
  assert.match(composed, /ROUTED INSTRUCTION/);
  assert.match(composed, /CONTRACT CLAUSE 7/);
  assert.equal(applyPreflightContexts("ROUTED", []), "ROUTED");
  const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
  assert.ok(orchestrator.includes("routedText ? applyPreflightContexts(routedText, preflightContexts) : text"),
    "an engineText override re-applies every preflight extraction");
});

await check("one send at a time: a second Enter during the staging wait cannot dispatch the same message twice", async () => {
  const composer = fs.readFileSync(new URL("../src/renderer/modules/composer.js", import.meta.url), "utf8");
  assert.match(composer, /if \(sendInFlight\) return;\n  sendInFlight = true;/,
    "sendPrompt awaits several times before the composer is cleared");
  assert.match(composer, /export function isSendInFlight/);
  assert.match(composer, /async function dispatchPrompt/);
  const refresh = composer.slice(composer.indexOf("export function refreshSendEnabled"), composer.indexOf("const COMPOSER_MIN_INPUT_H"));
  assert.match(refresh, /const preparing = attachmentStagingInFlight\(\) \|\| sendInFlight;/);
  assert.match(refresh, /submit\.disabled = \(!busy && !hasContent\) \|\| \(preparing && !stopMode\);/,
    "the button must actually disable while preparing — the class alone had no styling");
  const css = fs.readFileSync(new URL("../src/renderer/styles/composer.css", import.meta.url), "utf8");
  assert.match(css, /\.send-btn\.is-staging:not\(\.is-stop\)/, "the staging state is visible, not a dead class");
});

await check("the step-budget guard uses the SAME budget the engine was configured with, and there is no cap by default", async () => {
  const { configuredStepBudget } = require("../src/main/turn-step-budget.js");
  const { stepBudget } = require("../src/main/runtime/opencode-config-builder.js");
  assert.equal(typeof stepBudget, "function", "it was not exported, so the guard silently used a literal default");
  // 2026-09-16: there is no primary cap by default — 0 means the engine keeps
  // its own Infinity and the guard stays inert.
  assert.equal(configuredStepBudget({}), 0);
  assert.equal(stepBudget({}).primary, 0);
  assert.equal(configuredStepBudget({ LILY_OPENCODE_MAX_STEPS: "40" }), 40, "a lowered budget must be detected, not ignored");
  assert.equal(configuredStepBudget({ LILY_OPENCODE_MAX_STEPS: "300" }), 300, "a raised budget must be honoured, not overridden by a literal");
  assert.equal(configuredStepBudget({ LILY_OPENCODE_MAX_STEPS: "abc" }), 0);
  assert.equal(stepBudget({ LILY_OPENCODE_MAX_STEPS: "40" }).primary, 40);
});

await check("a follow-up resumes the previous REAL turn, not a platform record", async () => {
  const { lastRealTurnId } = require("../src/main/turn-preflight-context.js");
  assert.equal(lastRealTurnId([{ turnId: "t1" }, { turnId: "turn_closure_notice_abc" }]), "t1",
    "the 'send 继续' card must not become the turn a 继续 resumes");
  assert.equal(lastRealTurnId([{ turnId: "t1" }, { turnId: "turn_agent_binding_x" }, { turnId: "turn_task_pause_y" }]), "t1");
  assert.equal(lastRealTurnId([]), "");
  const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
  assert.ok(orchestrator.includes("recoverySourceForTurn?.(session.id, lastRealTurnId(historySession.messages))"));
});

console.log(`\n${checks} checks passed (attachment staging race)`);
