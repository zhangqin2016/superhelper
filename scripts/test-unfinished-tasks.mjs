#!/usr/bin/env node
// Unfinished-task list + resume: lifecycle rows left in outcome_unknown /
// failed / unverified / blocked / waiting_user are listed across the owner's
// sessions with the original request text; resuming annotates the old row
// (never rewrites it) so it leaves the list; the IPC resumes in the ORIGINAL
// conversation with sourceTurnId so the task core is inherited.
// [gate: task-completion-integrity]
// Run: node scripts/test-unfinished-tasks.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { projectUnfinished, RESUME_TEXT } = require("../src/main/ipc-tasks.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unfinished-tasks-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const OWNER = "profile:account:owner-u";
const OTHER = "profile:account:owner-v";

let admittedSeq = 0;
const ADMIT_BASE = Date.now() - 10 * 60 * 1000;
function admit(sessionId, turnId, text, ownerScope = OWNER) {
  admittedSeq += 1;
  store.db.run(
    `INSERT INTO turn_inputs (session_id, admitted_seq, turn_id, delivery, status, user_text, files_json, metadata_json, created_at, owner_scope, migration_status, migration_reason, terminal_type)
     VALUES (?, ?, ?, 'direct', 'promoted', ?, '[]', '{}', ?, ?, 'owned', 'owned', ?)`,
    // Deterministic order: two admits in the same millisecond must still read as "later".
    sessionId, admittedSeq, turnId, text, ADMIT_BASE + admittedSeq * 1000, ownerScope, "turn.stalled",
  );
}

function lifecycle(sessionId, turnId, status, ownerScope = OWNER) {
  const ensured = store.ensureTaskLifecycle({ sessionId, ownerScope, taskId: turnId, turnId, status: "admitted" });
  assert.ok(ensured.ok, `ensure ${turnId}: ${ensured.reason}`);
  if (status !== "admitted") {
    const path_ = status === "unverified" ? ["running", "verifying", "unverified"] : status === "outcome_unknown" ? ["running", "outcome_unknown"] : [status];
    for (const step of path_) {
      const moved = store.transitionTaskLifecycle({ sessionId, ownerScope, taskId: turnId, turnId, status: step, ...(step === "unverified" ? { verification: { status: "unverified", reason: "missing_test_or_build_evidence" } } : {}) });
      assert.ok(moved.ok, `transition ${turnId} → ${step}: ${moved.reason}`);
    }
  }
}

try {
  admit("s1", "t-stalled", "帮我实现一个工具平台");
  lifecycle("s1", "t-stalled", "outcome_unknown");
  // A finished task in its OWN conversation (a later turn in s1 would rightly supersede t-stalled).
  admit("s1-done", "t-done", "写个 README");
  lifecycle("s1-done", "t-done", "running");
  store.transitionTaskLifecycle({ sessionId: "s1-done", ownerScope: OWNER, taskId: "t-done", turnId: "t-done", status: "verifying" });
  store.transitionTaskLifecycle({ sessionId: "s1-done", ownerScope: OWNER, taskId: "t-done", turnId: "t-done", status: "verified", verification: { status: "verified" } });
  admit("s2", "t-unverified", "整理季度汇报");
  lifecycle("s2", "t-unverified", "unverified");
  admit("s3", "t-other-owner", "别人的任务", OTHER);
  lifecycle("s3", "t-other-owner", "outcome_unknown", OTHER);

  await check("only the conversation TAIL counts, and a completed-but-unverified answer is not unfinished", async () => {
    const rows = store.listUnfinishedTaskLifecycles(OWNER);
    assert.deepEqual(rows.map((row) => row.turnId).sort(), ["t-stalled"], "t-unverified answered; t-done finished");
    const stalled = rows.find((row) => row.turnId === "t-stalled");
    assert.equal(stalled.userText, "帮我实现一个工具平台");
    assert.equal(stalled.turnTerminalType, "turn.stalled");
    assert.equal(stalled.status, "outcome_unknown");
    assert.equal(store.listUnfinishedTaskLifecycles(OTHER).length, 1, "owner scopes are isolated");
    assert.equal(store.listUnfinishedTaskLifecycles("").length, 0);
  });

  await check("a later message in the conversation, a user interrupt, or age hide a row — the user has moved on", async () => {
    admit("s4", "t-old-stalled", "老任务");
    lifecycle("s4", "t-old-stalled", "outcome_unknown");
    store.db.run("UPDATE task_lifecycles SET updated_at=? WHERE turn_id='t-old-stalled'", Date.now() - 3 * 24 * 3600 * 1000);
    admit("s5", "t-interrupted", "被我停掉的");
    store.db.run("UPDATE turn_inputs SET terminal_type='turn.interrupted' WHERE turn_id='t-interrupted'");
    lifecycle("s5", "t-interrupted", "outcome_unknown");
    admit("s6", "t-first-fail", "第一次失败");
    lifecycle("s6", "t-first-fail", "failed");
    admit("s6", "t-retry", "再试一次");
    const ids = store.listUnfinishedTaskLifecycles(OWNER).map((row) => row.turnId);
    assert.deepEqual(ids, ["t-stalled"], `stale, interrupted and superseded rows stay out: ${ids}`);
    assert.ok(store.listUnfinishedTaskLifecycles(OWNER, { maxAgeMs: 30 * 24 * 3600 * 1000 }).map((row) => row.turnId).includes("t-old-stalled"), "age window is a parameter");
  });

  await check("annotating a row with resumedByTurnId removes it from the list without changing its status", async () => {
    const before = store.getTaskLifecycle("s1", OWNER, "t-stalled");
    const annotated = store.annotateTaskLifecycle({ sessionId: "s1", ownerScope: OWNER, turnId: "t-stalled", metadata: { resumedByTurnId: "t-new", resumedBy: "task_center" } });
    assert.equal(annotated.ok, true);
    assert.equal(annotated.lifecycle.status, "outcome_unknown", "status is untouched — the row stays an audit record");
    assert.equal(annotated.lifecycle.version, before.version, "no version bump for metadata-only annotation");
    assert.deepEqual(store.listUnfinishedTaskLifecycles(OWNER).map((row) => row.turnId), []);
    assert.equal(store.annotateTaskLifecycle({ sessionId: "s1", ownerScope: OWNER, turnId: "missing", metadata: { a: 1 } }).reason, "TASK_LIFECYCLE_NOT_FOUND");
    assert.equal(store.annotateTaskLifecycle({ sessionId: "s1", ownerScope: OWNER, turnId: "t-stalled" }).reason, "INVALID_TASK_LIFECYCLE");
  });

  await check("the IPC projection carries session/project names and marks missing sessions as not resumable", async () => {
    admit("s7", "t-proj", "整理季度汇报");
    lifecycle("s7", "t-proj", "outcome_unknown");
    const row = store.listUnfinishedTaskLifecycles(OWNER).find((item) => item.turnId === "t-proj");
    assert.ok(row, "a fresh stalled tail is listed");
    const ctx = {
      sessionManager: { findById: (id) => (id === "s7" ? { id: "s7", title: "汇报对话", projectId: "p9" } : null) },
      projectManager: { find: (id) => (id === "p9" ? { id: "p9", name: "季度工作" } : null) },
    };
    const projected = projectUnfinished(ctx, row);
    assert.equal(projected.sessionTitle, "汇报对话");
    assert.equal(projected.projectName, "季度工作");
    assert.equal(projected.resumable, true);
    assert.equal(projected.status, "outcome_unknown");
    const orphan = projectUnfinished({ sessionManager: { findById: () => null }, projectManager: { find: () => null } }, row);
    assert.equal(orphan.resumable, false);
    assert.equal(orphan.sessionMissing, true);
  });

  await check("resume copy exists in all three locales and reads as a continuation", async () => {
    for (const locale of ["zh-CN", "en", "ar"]) assert.ok(RESUME_TEXT[locale]?.length > 8, locale);
    assert.match(RESUME_TEXT["zh-CN"], /继续/);
  });

  await check("the resume IPC dispatches in the original conversation with sourceTurnId and annotates the old row", async () => {
    const src = fs.readFileSync(new URL("../src/main/ipc-tasks.js", import.meta.url), "utf8");
    assert.match(src, /sendUserMessage\(sessionId, text, \[\], \{ sourceTurnId: turnId/);
    assert.match(src, /annotateTaskLifecycle\?\.\(sessionId, \{\n\s+turnId,\n\s+metadata: \{ resumedByTurnId/);
    assert.match(src, /ALREADY_RESUMED/);
    assert.match(src, /"BUSY"/);
    const preload = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
    assert.match(preload, /tasks:list-unfinished/);
    assert.match(preload, /tasks:resume/);
  });

  console.log(`\n${checks} checks passed (unfinished tasks)`);
} finally {
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
