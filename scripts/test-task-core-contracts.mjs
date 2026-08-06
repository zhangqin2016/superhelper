#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TASK_CORE_SCHEMA_VERSION,
  createContextSnapshot,
  createTaskCoreEnvelope,
  createTaskAdmissionSnapshot,
  compareContextSources,
} = require("../src/main/task-core-contracts.js");
const { persistTaskCoreEnvelope } = require("../src/main/task-core-runtime.js");

const admission = createTaskAdmissionSnapshot({
  sessionId: "session-1",
  admitted: {
    admittedSeq: 17,
    turnId: "turn-1",
    sessionId: "session-1",
    delivery: "direct",
    status: "admitted",
    ownerScope: "profile-1",
    sourceTurnId: "turn-source",
    userText: "do not copy this text into a trace",
    metadata: {
      scheduledTaskId: "schedule-1",
      scheduledTaskRunId: "run-1",
      fromQueue: false,
    },
    externalCommandId: "command-1",
    externalIdempotencyKey: "idem-1",
  },
  taskRunId: "task-1",
});

assert.equal(TASK_CORE_SCHEMA_VERSION, 1);
assert.equal(admission.schemaVersion, 1);
assert.equal(admission.sessionId, "session-1");
assert.equal(admission.turnId, "turn-1");
assert.equal(admission.taskRunId, "task-1");
assert.equal(admission.source, "direct");
assert.equal(admission.external.commandId, "command-1");
assert.equal(admission.metadata.scheduledTaskId, "schedule-1");
assert.equal(JSON.stringify(admission).includes("do not copy"), false);
assert(Object.isFrozen(admission));
assert(Object.isFrozen(admission.metadata));

const contract = {
  active: true,
  kind: "code",
  taskType: "code_change",
  categories: ["code", "verification"],
  workspaceProfile: "repo",
  workspaceSignals: ["git"],
  intentContract: { contractId: "intent-1", revision: 2, relation: "new" },
};

const first = createContextSnapshot({
  sessionId: "session-1",
  admission,
  taskContract: contract,
  taskRun: {
    id: "task-1",
    agentGraphId: "graph-1",
    resumeState: {
      leadAttemptId: "attempt-1",
      lastToolId: "tool-1",
      hasSideEffects: true,
      nextAction: "verify output",
    },
    objective: "this objective must not be copied into context metadata",
    phase: "execute",
    status: "running",
    progress: { label: "Inspecting files", value: 25 },
  },
  contextMemory: {
    injected: true,
    text: "private memory text",
    fingerprint: "memory-fp",
    contextEpoch: 4,
    totalChars: 512,
    items: [{
      id: "memory-1",
      kind: "project_memory",
      reason: "grounding",
      sourceVersion: "v1",
      sourcePointers: ["README.md"],
      proof: true,
      relevance: 0.8,
      size: 120,
    }],
    skipped: [{ id: "memory-2", kind: "learned", skipReason: "budget" }],
    diagnostics: { selectedCount: 1, skippedCount: 1 },
  },
  files: [{ path: "/workspace/brief.docx", name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4096, mtimeMs: 100, contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", content: "must not be copied" }],
  projectId: "project-1",
  documentEvidence: { documents: [{ path: "brief.docx", text: "must not be copied" }], extractedPaths: ["brief.docx"], chunks: [{ id: "chunk-1" }], index: { ready: true } },
  characterSnapshot: {
    snapshotStatus: "ready",
    characterRevisionId: "character-rev-1",
    worldBookBindings: [{ worldBookRevisionId: "world-rev-1", scope: "character" }],
  },
  characterContext: {
    status: "compiled",
    fingerprint: "character-fp",
    activatedFields: ["persona", "style"],
    activatedWorldEntries: [{ id: "entry-1" }],
    tokenEstimate: 120,
  },
  capabilityReadiness: {
    status: "ready",
    unavailablePackIds: [],
    failedPackIds: [],
  },
});

const second = createContextSnapshot({
  sessionId: "session-1",
  admission,
  taskContract: contract,
  taskRun: {
    id: "task-1",
    phase: "execute",
    status: "running",
    progress: { label: "Inspecting files", value: 25 },
  },
  contextMemory: {
    injected: true,
    fingerprint: "memory-fp",
    contextEpoch: 4,
    totalChars: 512,
    items: [{
      id: "memory-1",
      kind: "project_memory",
      reason: "grounding",
      sourceVersion: "v1",
      sourcePointers: ["README.md"],
      proof: true,
      relevance: 0.8,
      size: 120,
    }],
    skipped: [{ id: "memory-2", kind: "learned", skipReason: "budget" }],
    diagnostics: { selectedCount: 1, skippedCount: 1 },
  },
  files: [{ path: "/workspace/brief.docx", name: "brief.docx", kind: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4096, mtimeMs: 100, contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  projectId: "project-1",
  documentEvidence: { documentCount: 1, extractedCount: 1, chunkCount: 1, index: { ready: true } },
  characterSnapshot: {
    snapshotStatus: "ready",
    characterRevisionId: "character-rev-1",
    worldBookBindings: [{ worldBookRevisionId: "world-rev-1" }],
  },
  characterContext: {
    status: "compiled",
    fingerprint: "character-fp",
    activatedFields: ["persona", "style"],
    activatedWorldEntries: [{ id: "entry-1" }],
    tokenEstimate: 120,
  },
  capabilityReadiness: { status: "ready" },
});

assert.equal(first.fingerprint, second.fingerprint, "fingerprint should ignore non-semantic input omissions");
assert.equal(first.context.memory.fingerprint, "memory-fp");
assert.equal(first.context.memory.items[0].sourceVersion, "v1");
assert.equal(first.character.worldBookRevisionIds[0], "world-rev-1");
assert.equal(first.taskRun.progress.label, "Inspecting files");
assert.equal(first.taskRun.id, "task-1");
assert.equal(first.taskRun.agentGraphId, "graph-1");
assert.equal(first.taskRun.leadAttemptId, "attempt-1");
assert.equal(first.taskRun.lastToolId, "tool-1");
assert.equal(first.taskRun.hasSideEffects, true);
assert.equal(first.taskRun.nextAction, "verify output");
assert.equal(first.sources.projectId, "project-1");
assert.equal(first.sources.files[0].path, "/workspace/brief.docx");
assert.equal(first.sources.files[0].modifiedAt, 100);
assert.equal(first.sources.files[0].contentHash, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert.equal(first.sources.documents.chunkCount, 1);
assert.equal(JSON.stringify(first).includes("private memory text"), false);
assert.equal(JSON.stringify(first).includes("this objective"), false);
assert.equal(JSON.stringify(first).includes("must not be copied"), false);
assert.equal(JSON.stringify(first).includes("README.md"), true);
assert(Object.isFrozen(first));
assert(Object.isFrozen(first.context));
assert(Object.isFrozen(first.context.memory.items[0]));
assert.match(first.sourceFingerprint, /^[a-f0-9]{64}$/);
assert.equal(compareContextSources({ contextSnapshot: first }, first).drifted, false);
assert.equal(compareContextSources({ contextSnapshot: { sourceFingerprint: "changed" } }, first).drifted, true);

const originalFingerprint = first.fingerprint;
const changed = createContextSnapshot({
  sessionId: "session-1",
  admission,
  taskContract: first.contract,
  contextMemory: { fingerprint: "memory-fp-2", contextEpoch: 4, items: [] },
});
assert.notEqual(changed.fingerprint, originalFingerprint, "source changes must invalidate the snapshot");
const changedFile = createContextSnapshot({
  sessionId: "session-1",
  admission,
  files: [{ path: "/workspace/brief.docx", name: "brief.docx", size: 4096, mtimeMs: 101 }],
});
assert.notEqual(changedFile.sourceFingerprint, first.sourceFingerprint, "same-size file changes must invalidate source snapshot");

const failOpen = createContextSnapshot({ sessionId: "session-1", admission: null, taskContract: null });
assert.equal(failOpen.sessionId, "session-1");
assert.equal(failOpen.admission, null);
assert.equal(failOpen.context.memory.items.length, 0);

const taskCore = createTaskCoreEnvelope({
  sessionId: "session-1",
  projectId: "project-1",
  admission,
  contextSnapshot: first,
  taskContract: {
    ...contract,
    intentContract: {
      contractId: "intent-1",
      revision: 2,
      taskType: "code_change",
      objective: "stable objective",
      deliverables: ["changed files"],
      successCriteria: ["tests pass"],
      constraints: ["do not delete data"],
      neededCapabilities: ["node"],
    },
  },
  files: [{ path: "/workspace/brief.docx", name: "brief.docx" }],
});
assert.equal(taskCore.sessionId, "session-1");
assert.equal(taskCore.contract.intentContract.objective, "stable objective");
assert.equal(taskCore.contextSnapshot.fingerprint, first.fingerprint);
assert.equal(taskCore.recovery, undefined);
assert(Object.isFrozen(taskCore));
assert.throws(
  () => createTaskCoreEnvelope({
    sessionId: "other-session",
    admission,
    contextSnapshot: first,
  }),
  /TASK_CORE_SESSION_SCOPE_MISMATCH/,
);

const registryFailureState = {
  turnId: "turn-1",
  lifecycleTaskId: "turn-1",
  taskAdmission: admission,
  contextSnapshot: first,
  taskRun: { id: "task-1", agentGraphId: "", resumeState: {} },
  currentPayload: { files: [] },
  startedAt: 100,
};
const registryFailure = persistTaskCoreEnvelope(
  {
    ctx: {
      sessionManager: {
        persistTaskContextSnapshot() { throw new Error("registry offline"); },
        persistTurnTaskCore() { return { ok: true }; },
      },
    },
  },
  { id: "session-1", projectId: "project-1" },
  registryFailureState,
);
assert.equal(registryFailure.ok, true);
assert.equal(registryFailureState.contextRegistryId, "");
assert.equal(registryFailure.taskCore.contextRegistryId, undefined);

console.log("task-core-contracts: ok");
