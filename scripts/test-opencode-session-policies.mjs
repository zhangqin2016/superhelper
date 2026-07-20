#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const failurePolicy = require("../src/main/opencode-session-failure-policy.js");
const todoPolicy = require("../src/main/opencode-todo-completion-policy.js");
const { createOpencodeHistoryRecovery, withTimeout } = require("../src/main/opencode-history-recovery.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-policies-"));
try {
  const documentPath = path.join(tmp, "source.pdf");
  const completedPath = path.join(tmp, "complete.pdf");
  fs.writeFileSync(documentPath, "source");
  fs.writeFileSync(completedPath, "complete");

  const noFiles = { text: "hello", files: [] };
  assert.equal(failurePolicy.buildAttachmentFallbackPromptPayload(noFiles, "failure"), noFiles);
  const original = { text: "read this", files: [{ path: documentPath, type: "application/pdf" }] };
  const fallback = failurePolicy.buildAttachmentFallbackPromptPayload(original, "upload failed");
  assert.equal(original.files.length, 1, "fallback must not mutate the original payload");
  assert.deepEqual(fallback.files, []);
  assert.equal(fallback.attachmentFallback, true);
  assert.match(fallback.text, /Attachment fallback manifest/);
  assert(fallback.text.includes(documentPath));
  assert.equal(failurePolicy.shouldIsolateAttachmentFallback(original), true);
  assert.equal(failurePolicy.shouldIsolateAttachmentFallback({ files: [{ path: "photo.png" }] }), false);

  const gatewayRoute = { modelRouteAudit: { route: "gateway", keyKind: "gateway-token" } };
  assert.equal(failurePolicy.isManagedModelConfigStale(null, "401 Unauthorized", gatewayRoute), true);
  assert.equal(failurePolicy.isOversizedContextFailure(null, "413 Request Entity Too Large"), true);
  assert.equal(failurePolicy.isSafeReplayableModelFailure(null, "socket closed"), true);
  assert.equal(failurePolicy.isSafeReplayableModelFailure({ retryable: false }, "socket closed"), false);
  assert.equal(failurePolicy.shouldDropResumeAfterVisibleFailure({ classified: { code: "SESSION_INVALID" } }), true);
  assert.equal(failurePolicy.shouldDropResumeAfterVisibleFailure({ classified: { code: "TOOL_FAILED", retryable: false } }), false);

  const todos = todoPolicy.nativeTodoSnapshot([
    { content: "Inspect", status: "done" },
    { activeForm: "Verify", status: "running" },
  ]);
  assert.deepEqual(todos, {
    total: 2,
    completed: 1,
    unfinished: [{ title: "Verify", status: "in_progress" }],
  });
  assert.match(todoPolicy.buildTodoContinuationPrompt(todos, 2, 3), /Continuation attempt: 2\/3/);
  assert.equal(todoPolicy.detectIncompleteDeliverable(`Saved ${completedPath}`), null);
  assert.equal(todoPolicy.detectIncompleteDeliverable(`Saved ${path.join(tmp, "missing.pdf")}`)?.reason, "does not exist");
  assert.equal(todoPolicy.detectIncompleteDeliverable("Saved relative/output.pdf"), null);

  const turnStartedAt = 1_000;
  const messages = [
    { info: { id: "old", role: "assistant", time: { created: 900, completed: 950 } }, parts: [{ type: "text", text: "old" }] },
    { info: { id: "user", role: "user", time: { created: 1_100 } }, parts: [{ type: "text", text: "question" }] },
    { info: { id: "answer", role: "assistant", time: { created: 1_200, completed: 1_300 } }, parts: [{ type: "text", text: "final answer" }] },
  ];
  const supplemental = [];
  const recovery = createOpencodeHistoryRecovery({
    getServer: () => ({ lastPromptText: "question", messages: async () => ({ data: messages }) }),
    getTurnStartedAt: () => turnStartedAt,
    getSessionStatus: async () => "idle",
    onSupplementalOutput: (value) => supplemental.push(value),
  });
  assert.deepEqual(await recovery.latestAssistant({ requireCurrentPrompt: true }), {
    output: "final answer",
    engineMessageId: "answer",
    completed: true,
    completedAt: 1_300,
    createdAt: 1_200,
  });
  const synced = await recovery.syncFinalOutput({ code: 0, output: "final" });
  assert.equal(synced.output, "final answer");
  assert.equal(synced.resultFromOfficialHistory, true);
  assert.deepEqual(supplemental, [{ official: "final answer", missing: " answer" }]);

  const incompleteMessages = messages.map((item) => item.info.id === "answer"
    ? { ...item, info: { ...item.info, time: { created: 1_200 } } }
    : item);
  const idleRecovery = createOpencodeHistoryRecovery({
    getServer: () => ({ lastPromptText: "question", messages: async () => incompleteMessages }),
    getTurnStartedAt: () => turnStartedAt,
    getSessionStatus: async () => "idle",
    getSyncTimeoutMs: () => 50,
  });
  assert.equal((await idleRecovery.recoverStalledFinal())?.output, "final answer");
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    assert.equal(await withTimeout(new Promise(() => {}), 5, "fallback"), "fallback");
  } finally {
    clearTimeout(keepAlive);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("opencode-session-policies: ok");
