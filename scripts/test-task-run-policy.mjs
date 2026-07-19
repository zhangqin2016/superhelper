#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  addTaskRisk,
  assessTaskVerification,
  buildTaskToolEvidence,
  completeTaskRun,
  createTaskRun,
  noteTaskToolUse,
} = require("../src/main/task-run-state.js");

{
  const code = assessTaskVerification({
    taskType: "code",
    evidence: [{ kind: "tool_result", label: "npm test", status: "done" }],
  });
  if (code.status !== "verified" || code.reason !== "test_or_build_evidence") {
    throw new Error(`code test evidence should verify task: ${JSON.stringify(code)}`);
  }
}

{
  const evidence = buildTaskToolEvidence({
    id: "shell_1",
    name: "shell_command",
    title: "Run focused tests",
    input: { command: "node scripts/test-task-contract.mjs" },
    status: "done",
  });
  if (!evidence.label.includes("test-task-contract.mjs")) {
    throw new Error(`tool evidence must retain bounded command/title detail: ${JSON.stringify(evidence)}`);
  }
  const code = assessTaskVerification({
    taskType: "code_change",
    evidence: [evidence],
    successCriteria: ["focused_test", "no_unrelated_refactor"],
    deliverables: ["requested_workspace_change"],
    fileChangeCount: 1,
  });
  if (code.status !== "verified" || !code.criteria.some((item) => item.criterion === "focused_test" && item.status === "verified")) {
    throw new Error(`code_change success criteria should consume real test evidence: ${JSON.stringify(code)}`);
  }
}

{
  const uiManual = assessTaskVerification({
    taskType: "ui_change",
    evidence: [{ kind: "tool_result", label: "playwright screenshot visual check done", status: "done" }],
    successCriteria: ["renderer_test_or_manual_check"],
    deliverables: ["requested_visible_ui_change"],
    fileChangeCount: 1,
  });
  if (uiManual.status !== "observed" || uiManual.criteria[0]?.status !== "verified") {
    throw new Error(`UI verification must accept its declared manual/visual alternative: ${JSON.stringify(uiManual)}`);
  }
}

{
  const weak = assessTaskVerification({
    taskType: "code",
    evidence: [{ kind: "tool_result", label: "Read done", status: "done" }],
  });
  if (weak.status !== "unverified" || weak.reason !== "missing_test_or_build_evidence") {
    throw new Error(`code task without test/build evidence should be unverified: ${JSON.stringify(weak)}`);
  }
}

{
  const unknown = assessTaskVerification({ taskType: "", evidence: [] });
  if (unknown.status !== "not_required") {
    throw new Error(`unknown task should not require verification: ${JSON.stringify(unknown)}`);
  }
}

{
  const observed = assessTaskVerification({
    taskType: "document",
    evidence: [{ kind: "tool_result", label: "Read PDF", status: "done" }],
  });
  if (observed.status !== "observed" || observed.reason !== "evidence_present") {
    throw new Error(`non-code evidence should be observed, not over-verified: ${JSON.stringify(observed)}`);
  }
}

{
  const gate = assessTaskVerification({
    taskType: "code",
    evidenceGateAssessment: { ok: false, code: "MISSING_SOURCE_COVERAGE" },
  });
  if (gate.status !== "unverified" || gate.reason !== "MISSING_SOURCE_COVERAGE") {
    throw new Error(`evidence gate should remain authoritative: ${JSON.stringify(gate)}`);
  }
}

{
  const complete = assessTaskVerification({
    taskType: "content_extraction",
    evidenceGateAssessment: { ok: true },
    evidenceSummary: {
      hasSourceContentEvidence: true,
      sourceContentCoverage: { status: "complete" },
    },
  });
  if (complete.status !== "verified" || complete.reason !== "source_content_extracted") {
    throw new Error(`complete source extraction should verify: ${JSON.stringify(complete)}`);
  }

  const native = assessTaskVerification({
    taskType: "content_extraction",
    evidenceGateAssessment: { ok: true },
    evidenceSummary: {
      hasSourceContentEvidence: true,
      sourceContentCoverage: { status: "available" },
    },
  });
  if (native.status !== "observed" || native.reason !== "source_content_available") {
    throw new Error(`native source delivery should stay observed: ${JSON.stringify(native)}`);
  }

  const missing = assessTaskVerification({
    taskType: "content_extraction",
    evidenceGateAssessment: { ok: true },
    evidenceSummary: { hasSourceContentEvidence: false, sourceContentCoverage: { status: "unavailable" } },
  });
  if (missing.status !== "unverified" || missing.reason !== "missing_source_content_evidence") {
    throw new Error(`missing source content must stay unverified: ${JSON.stringify(missing)}`);
  }
}

{
  const taskRun = createTaskRun({ sessionId: "s", turnId: "t", objective: "finish todos" });
  taskRun.plan = [
    { id: "todo_1", title: "Read", status: "completed" },
    { id: "todo_2", title: "Patch", status: "in_progress" },
    { id: "todo_3", title: "Test", status: "pending" },
  ];
  completeTaskRun(taskRun, "turn.completed", { status: "verified" });
  if (!taskRun.plan.every((step) => step.status === "completed")) {
    throw new Error(`completed TaskRun should close all todo plan steps: ${JSON.stringify(taskRun.plan)}`);
  }
  if (taskRun.completionStatus !== "verified_complete") {
    throw new Error(`verified task should expose truthful completion status: ${JSON.stringify(taskRun)}`);
  }
}

{
  const taskRun = createTaskRun({
    sessionId: "s",
    turnId: "t_unverified",
    objective: "change code",
    intentContract: {
      taskType: "code_change",
      objective: "change code",
      deliverables: ["requested_workspace_change"],
      successCriteria: ["focused_test"],
    },
  });
  const verification = assessTaskVerification({
    taskType: "code_change",
    evidence: [{ label: "Read source done", status: "done" }],
    successCriteria: taskRun.successCriteria,
    deliverables: taskRun.deliverables,
    fileChangeCount: 1,
  });
  completeTaskRun(taskRun, "turn.completed", verification);
  if (taskRun.status !== "completed" || taskRun.completionStatus !== "delivered_unverified") {
    throw new Error(`legacy completion must remain compatible while verification stays honest: ${JSON.stringify(taskRun)}`);
  }
}

{
  const taskRun = createTaskRun({ sessionId: "s", turnId: "t", objective: "resolve transient risks" });
  addTaskRisk(taskRun, { code: "NO_VISIBLE_PROGRESS", level: "info", message: "waiting" });
  addTaskRisk(taskRun, { code: "ENGINE_WARNING", level: "warning", message: "real warning" });
  completeTaskRun(taskRun, "turn.completed", { status: "observed" });
  const noVisible = taskRun.risks.find((risk) => risk.code === "NO_VISIBLE_PROGRESS");
  const warning = taskRun.risks.find((risk) => risk.code === "ENGINE_WARNING");
  if (noVisible?.status !== "resolved" || warning?.status === "resolved") {
    throw new Error(`completed TaskRun should resolve only transient progress risks: ${JSON.stringify(taskRun.risks)}`);
  }
}

{
  const readOnly = createTaskRun({ sessionId: "s", turnId: "t", objective: "read" });
  noteTaskToolUse(readOnly, { id: "read_1", name: "Read" });
  if (readOnly.resumeState.recoveryLevel !== "safe" || readOnly.resumeState.replaySafe !== true) {
    throw new Error(`read-only tools should be safe recovery: ${JSON.stringify(readOnly.resumeState)}`);
  }
  const command = createTaskRun({ sessionId: "s", turnId: "t", objective: "command" });
  noteTaskToolUse(command, { id: "bash_1", name: "Bash" });
  if (command.resumeState.recoveryLevel !== "confirm" || command.resumeState.replaySafe !== false) {
    throw new Error(`unknown command tools should require confirmation: ${JSON.stringify(command.resumeState)}`);
  }
  const intentCommit = createTaskRun({ sessionId: "s", turnId: "t", objective: "understand" });
  noteTaskToolUse(intentCommit, { id: "intent_1", name: "lily_intent_contract_commit" });
  if (intentCommit.resumeState.recoveryLevel !== "safe" || intentCommit.resumeState.replaySafe !== true) {
    throw new Error(`host-owned intent refinement should remain replay-safe: ${JSON.stringify(intentCommit.resumeState)}`);
  }
  const edit = createTaskRun({ sessionId: "s", turnId: "t", objective: "edit" });
  noteTaskToolUse(edit, { id: "edit_1", name: "Edit" });
  if (edit.resumeState.recoveryLevel !== "dangerous" || edit.resumeState.replaySafe !== false) {
    throw new Error(`write tools should be dangerous recovery: ${JSON.stringify(edit.resumeState)}`);
  }
  const destructiveShell = createTaskRun({ sessionId: "s", turnId: "t", objective: "delete" });
  noteTaskToolUse(destructiveShell, { id: "bash_2", name: "Bash", input: { command: "rm -rf dist" } });
  if (destructiveShell.resumeState.recoveryLevel !== "dangerous") {
    throw new Error(`destructive shell commands should be dangerous recovery: ${JSON.stringify(destructiveShell.resumeState)}`);
  }
}

console.log("task-run-policy: ok");
