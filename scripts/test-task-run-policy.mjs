#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  addTaskRisk,
  assessTaskVerification,
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
