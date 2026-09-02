#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const failurePolicy = require("../src/main/opencode-session-failure-policy.js");
const todoPolicy = require("../src/main/opencode-todo-completion-policy.js");
const continuationBudget = require("../src/main/turn-continuation-budget.js");
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
  // PERMISSION_DENIED (macOS TCC / Windows Controlled Folder Access) gets one
  // bounded silent replay with a fresh engine before anything reaches the user.
  assert.equal(failurePolicy.isSafeReplayableModelFailure({ code: "PERMISSION_DENIED", retryable: true }, ""), true);
  assert.equal(failurePolicy.isLocalPermissionFailure({ code: "PERMISSION_DENIED" }), true);
  assert.equal(failurePolicy.isLocalPermissionFailure({ code: "QUOTA_EXCEEDED" }), false);
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

  // The gate bounds CONFIRMED no-progress, not effort (CAPABILITY-GATE rule 3).
  const finished = { total: 2, completed: 2, unfinished: [] };
  assert.equal(todoPolicy.todoContinuationDecision(finished, 0, 0), "skip");
  assert.equal(todoPolicy.todoContinuationDecision({}, 0, 0), "skip");
  assert.equal(todoPolicy.todoContinuationDecision(todos, 0, 0), "nudge");
  assert.equal(
    todoPolicy.todoContinuationDecision(todos, todoPolicy.TODO_COMPLETION_GATE_MAX_ATTEMPTS, 0),
    "settle",
    "consecutive nudges that changed nothing must stop",
  );
  assert.equal(
    todoPolicy.todoContinuationDecision(todos, 0, todoPolicy.TODO_COMPLETION_GATE_MAX_TOTAL_ATTEMPTS),
    "settle",
    "a model that keeps re-planning still hits an absolute per-turn ceiling",
  );

  // Giving up on an ANSWERED turn must not fabricate a stalled terminal — that
  // buried a complete delivery under a "no final answer" banner.
  const answered = todoPolicy.buildTodoGiveUpPayload({ code: 0, output: "交付完成。" }, todos, "");
  assert.equal(answered.stalled, undefined, "an answered turn is not stalled");
  assert.equal(answered.unfinishedTodoCount, 1);
  assert.match(answered.output, /^交付完成。/);
  assert.match(answered.output, /本轮还有 1 项待办没有标记完成：Verify/);
  // Falls back to the streamed output when the payload carries none.
  assert.match(todoPolicy.buildTodoGiveUpPayload({ code: 0 }, todos, "streamed").output, /^streamed/);
  // No answer at all is the ONLY case that still deserves the stalled terminal.
  const answerless = todoPolicy.buildTodoGiveUpPayload({ code: 0, output: "  " }, todos, "");
  assert.equal(answerless.stalled, true, "an answerless turn keeps the stalled terminal");
  assert.equal(answerless.output, "");
  assert.equal(todoPolicy.buildUnfinishedTodoNotice({ unfinished: [] }), "");

  // One shared budget across every gate that re-enters a cleanly-ended turn.
  const savedBudget = process.env.LILY_TURN_CONTINUATION_BUDGET;
  try {
    delete process.env.LILY_TURN_CONTINUATION_BUDGET;
    assert.equal(continuationBudget.maxTurnContinuations(), continuationBudget.DEFAULT_MAX_TURN_CONTINUATIONS);
    const state = continuationBudget.createTurnGateState();
    assert.deepEqual(state.todo, { attempts: 0, total: 0, best: Infinity });
    assert.equal(state.deliverableGated, false);
    for (let i = 0; i < continuationBudget.DEFAULT_MAX_TURN_CONTINUATIONS; i += 1) {
      assert.equal(continuationBudget.claimContinuation(state, i % 2 ? "todo" : "deliverable"), true);
    }
    assert.equal(continuationBudget.claimContinuation(state, "requiredTool"), false, "the shared budget runs out");
    assert.equal(state.continuations, continuationBudget.DEFAULT_MAX_TURN_CONTINUATIONS);
    assert.deepEqual(state.byGate, { deliverable: 2, todo: 2 }, "the budget records which gate spent it");

    // Kill switch: 0 removes the shared cap and restores per-gate-only bounds.
    process.env.LILY_TURN_CONTINUATION_BUDGET = "0";
    const unbounded = continuationBudget.createTurnGateState();
    for (let i = 0; i < 25; i += 1) assert.equal(continuationBudget.claimContinuation(unbounded, "todo"), true);
    // A malformed override must fail open to the default, never to unbounded.
    process.env.LILY_TURN_CONTINUATION_BUDGET = "not-a-number";
    assert.equal(continuationBudget.maxTurnContinuations(), continuationBudget.DEFAULT_MAX_TURN_CONTINUATIONS);
    process.env.LILY_TURN_CONTINUATION_BUDGET = "-3";
    assert.equal(continuationBudget.maxTurnContinuations(), continuationBudget.DEFAULT_MAX_TURN_CONTINUATIONS);
    // A gate wired before the state exists must not crash a turn.
    assert.equal(continuationBudget.claimContinuation(undefined, "todo"), true);
  } finally {
    if (savedBudget === undefined) delete process.env.LILY_TURN_CONTINUATION_BUDGET;
    else process.env.LILY_TURN_CONTINUATION_BUDGET = savedBudget;
  }
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

  // enrichPermissionFailureMessage: a visible PERMISSION_DENIED failure runs
  // the main-process workspace probe and appends an actionable diagnosis;
  // other failures and healthy workspaces pass the message through untouched.
  const plain = failurePolicy.enrichPermissionFailureMessage({ message: "Request failed: 401 Unauthorized" });
  assert.equal(plain, "Request failed: 401 Unauthorized", "non-permission failures stay untouched");
  const permRaw = "EPERM: operation not permitted, open '/x'";
  const healthy = failurePolicy.enrichPermissionFailureMessage({ message: permRaw, workspacePath: tmp });
  assert.equal(healthy, permRaw, "writable workspace → no diagnosis appended");
  if (process.platform !== "win32") {
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "lily-perm-blocked-"));
    fs.chmodSync(blocked, 0o555);
    const enriched = failurePolicy.enrichPermissionFailureMessage({ message: permRaw, workspacePath: blocked });
    assert.match(enriched, /诊断：/, "blocked workspace appends the diagnosis");
    assert.match(enriched, /不可读写/, "diagnosis names the unreadable directory");
    fs.chmodSync(blocked, 0o755);
    fs.rmSync(blocked, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("opencode-session-policies: ok");
