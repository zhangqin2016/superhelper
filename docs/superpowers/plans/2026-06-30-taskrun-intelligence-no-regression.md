# TaskRun Intelligence No-Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lily Workbench smarter for long-running tasks by adding TaskRun plan fusion, safe recovery metadata, task-type verification, and history/background observability without making the existing OpenCode execution path worse.

**Architecture:** Keep OpenCode as the execution engine and keep TaskRun as a fail-open platform-side observer. All new capability must be derived from existing runtime events, task contracts, tool facts, and persisted turn records. If TaskRun derivation, rendering, or recovery metadata fails, the baseline turn/tool/chat path must continue exactly as today.

**Tech Stack:** Electron main process, OpenCode runtime events, renderer runtime store, existing runtime-event bus, existing test suite under `scripts/test-*.mjs`.

---

## Non-Regression Contract

Every task below must preserve these invariants:

- TaskRun failure never prevents `runner.sendUserMessage`.
- TaskRun event emission is best-effort and caught.
- Liveness heartbeats do not reset meaningful-progress timers.
- Recovery metadata never auto-replays side-effecting tools.
- Verification status never blocks the assistant response; it only labels the result.
- Renderer TaskRun UI failure hides the enhancement and leaves chat/timeline usable.
- Existing tests plus the new guard tests must pass before commit.

Required guard tests:

```bash
node scripts/test-task-run-kernel.mjs
node scripts/test-session-runtime-store.mjs
node scripts/test-live-task-strip.mjs
node scripts/test-opencode-agent-session.mjs
node scripts/test-turn-orchestrator.mjs
npm run test:unit
```

Expected final result:

```text
240+/240+ passed
```

---

## File Map

- Modify `src/main/task-run-state.js`: add plan fusion, recovery policy, verification policy helpers.
- Modify `src/main/turn-orchestrator.js`: call helpers from existing runtime draft handlers and finalization.
- Modify `src/main/runtime-event-schema.js`: add only additive `task.*` event types if needed.
- Modify `src/main/store/runtime-event-persistence.js`: compact any new TaskRun payload fields.
- Modify `src/renderer/modules/session-runtime-store.js`: preserve new TaskRun fields on live turns.
- Modify `src/renderer/modules/live-task-strip.js`: show only compact status, not a new dashboard.
- Create or update tests:
  - `scripts/test-task-run-kernel.mjs`
  - `scripts/test-session-runtime-store.mjs`
  - `scripts/test-live-task-strip.mjs`
  - new `scripts/test-task-run-policy.mjs` if helper logic grows beyond simple integration tests.
- Optional later UI file if needed: `src/renderer/modules/task-run-detail.js`, but do not create it until live strip is insufficient.

---

## Phase 1: Plan Fusion

**Purpose:** Make TaskRun plan smarter by merging existing `todo.updated`, task contract, and current tool phase. This improves observability without asking OpenCode to change behavior.

### Task 1: Add Plan Fusion Helper

**Files:**
- Modify: `src/main/task-run-state.js`
- Test: `scripts/test-task-run-kernel.mjs` or new `scripts/test-task-run-policy.mjs`

- [x] **Step 1: Write failing test**

Add assertions covering:

```js
const taskRun = createTaskRun({ sessionId: "s", turnId: "t", objective: "change code" });
const updated = applyTaskPlanFromTodos(taskRun, [
  { content: "Read files", status: "completed" },
  { content: "Patch code", status: "in_progress" },
  { content: "Run tests", status: "pending" },
]);
assert.equal(updated.plan[1].title, "Patch code");
assert.equal(updated.activeStep, updated.plan[1].id);
assert.equal(updated.plan[2].status, "pending");
```

Also assert malformed todos degrade to existing default plan:

```js
const before = JSON.stringify(taskRun.plan);
applyTaskPlanFromTodos(taskRun, [{ content: "", status: "weird" }]);
assert.equal(JSON.stringify(taskRun.plan), before);
```

- [x] **Step 2: Implement helper**

Add an exported helper in `src/main/task-run-state.js`:

```js
function applyTaskPlanFromTodos(taskRun, todos = []) {
  if (!taskRun || !Array.isArray(todos)) return null;
  const normalized = todos
    .map((todo, index) => ({
      id: `todo_${index + 1}`,
      title: safeText(todo?.content || todo?.activeForm || "", 180),
      status: todo?.status === "completed" || todo?.status === "in_progress" ? todo.status : "pending",
    }))
    .filter((todo) => todo.title);
  if (!normalized.length) return taskRun;
  taskRun.plan = normalized.slice(0, 20);
  const active = taskRun.plan.find((step) => step.status === "in_progress")
    || taskRun.plan.find((step) => step.status !== "completed")
    || taskRun.plan.at(-1);
  taskRun.activeStep = active?.id || taskRun.activeStep || "execute";
  touch(taskRun);
  return taskRun;
}
```

- [x] **Step 3: Wire todo.updated**

In `src/main/turn-orchestrator.js`, inside `case "todo.updated"`, after `todos` normalization, call:

```js
this._updateTaskPlanFromTodos(sessionId, todos);
```

Add `_updateTaskPlanFromTodos` using `_emitTaskEvent("task.plan.updated", ...)`, with try/catch.

- [x] **Step 4: Run tests**

```bash
node scripts/test-task-run-kernel.mjs
node scripts/test-turn-orchestrator.mjs
```

Expected: both pass.

**No-Dumber Gate:** If todo parsing fails, default TaskRun plan remains. If task plan event fails, todo timeline still renders as today.

---

## Phase 2: Safe Recovery Metadata

**Purpose:** Make the platform explain whether a long task can be retried or resumed, without automatically replaying side-effecting work.

### Task 2: Track Recovery Policy

**Files:**
- Modify: `src/main/task-run-state.js`
- Modify: `src/main/turn-orchestrator.js`
- Test: `scripts/test-task-run-kernel.mjs`

- [x] **Step 1: Write failing test**

Add a test that runs:

```js
ctx.turnOrchestrator.ingest(session.id, [
  { type: "tool.started", payload: { id: "read_1", name: "Read", input: { file_path: "README.md" } } },
  { type: "tool.done", payload: { id: "read_1", status: "done", result: "ok" } },
]);
```

Assert TaskRun recovery state says retry is allowed:

```js
assert.equal(taskCompleted.payload.taskRun.resumeState.replaySafe, true);
```

Add side-effecting command:

```js
ctx.turnOrchestrator.ingest(session.id, [
  { type: "tool.started", payload: { id: "bash_1", name: "Bash", input: { command: "npm test" } } },
]);
```

Assert:

```js
assert.equal(taskRun.resumeState.replaySafe, false);
assert.equal(taskRun.resumeState.hasSideEffects, true);
```

- [x] **Step 2: Implement classifier**

Add to `src/main/task-run-state.js`:

```js
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "find", "search"]);

function noteTaskToolUse(taskRun, tool = {}) {
  if (!taskRun) return null;
  const name = String(tool.name || "").toLowerCase();
  const readOnly = READ_ONLY_TOOLS.has(name);
  taskRun.resumeState = {
    ...(taskRun.resumeState || {}),
    lastToolId: tool.id || taskRun.resumeState?.lastToolId || "",
    lastToolName: tool.name || taskRun.resumeState?.lastToolName || "",
    hasSideEffects: Boolean(taskRun.resumeState?.hasSideEffects || !readOnly),
    replaySafe: Boolean(readOnly && !taskRun.resumeState?.hasSideEffects),
    recoveryReason: readOnly ? "read_only_tools_only" : "side_effect_tool_seen",
  };
  touch(taskRun);
  return taskRun.resumeState;
}
```

- [x] **Step 3: Wire tool.started**

In `_markTaskProgress` or `case "tool.started"`, call `noteTaskToolUse(state.taskRun, tool)` before emitting progress.

- [x] **Step 4: Surface in live strip**

Only add one compact line in `live-task-strip.js` if recovery state is present:

```js
if (taskRun.resumeState?.replaySafe === false) {
  items.push({ status: "warning", content: translate("task.strip.noAutoReplay") });
}
```

Add i18n keys for en/zh/ar.

- [x] **Step 5: Run tests**

```bash
node scripts/test-task-run-kernel.mjs
node scripts/test-live-task-strip.mjs
npm run test:unit
```

Expected: all pass.

**No-Dumber Gate:** This must not trigger replay. It only annotates safety. Existing OpenCode replay logic remains source of truth.

---

## Phase 3: Task-Type Verification Policy

**Purpose:** Make `completed_verified` vs `completed_unverified` smarter while never blocking user-visible answers.

### Task 3: Add Verification Classifier

**Files:**
- Modify: `src/main/task-run-state.js`
- Modify: `src/main/turn-orchestrator.js`
- Test: new `scripts/test-task-run-policy.mjs`

- [x] **Step 1: Write tests**

Code task with tool evidence:

```js
const code = assessTaskVerification({
  taskType: "code",
  evidence: [{ kind: "tool_result", label: "npm test", status: "done" }],
});
assert.equal(code.status, "verified");
```

Code task without test/build:

```js
const weak = assessTaskVerification({
  taskType: "code",
  evidence: [{ kind: "tool_result", label: "Read done", status: "done" }],
});
assert.equal(weak.status, "unverified");
```

Unknown task stays non-blocking:

```js
const unknown = assessTaskVerification({ taskType: "", evidence: [] });
assert.equal(unknown.status, "not_required");
```

- [x] **Step 2: Implement classifier**

Add helper:

```js
function assessTaskVerification({ taskType = "", evidence = [], evidenceGateAssessment = null } = {}) {
  if (evidenceGateAssessment) {
    return {
      status: evidenceGateAssessment.ok ? "verified" : "unverified",
      reason: evidenceGateAssessment.ok ? "" : (evidenceGateAssessment.reason || evidenceGateAssessment.code || "evidence_gate_failed"),
    };
  }
  const labels = evidence.map((item) => String(item.label || "").toLowerCase()).join("\n");
  if (taskType === "code") {
    const hasTest = /\b(test|lint|typecheck|build)\b/.test(labels);
    return hasTest ? { status: "verified", reason: "test_or_build_evidence" } : { status: "unverified", reason: "missing_test_or_build_evidence" };
  }
  return evidence.length ? { status: "verified", reason: "evidence_present" } : { status: "not_required", reason: "" };
}
```

- [x] **Step 3: Wire finalization**

In `_completeTaskRun`, pass:

```js
taskType: state.turnPolicy?.taskType || state.taskContract?.taskType || ""
```

Use `assessTaskVerification` unless evidence gate already provided a stricter result.

- [x] **Step 4: Renderer label only**

Do not block the assistant. If `verification.status === "unverified"`, show compact strip/history metadata later.

- [x] **Step 5: Run tests**

```bash
node scripts/test-task-run-policy.mjs
node scripts/test-task-run-kernel.mjs
npm run test:unit
```

Expected: all pass.

**No-Dumber Gate:** Verification never changes terminal type from `turn.completed` to failure. It only labels confidence.

---

## Phase 4: History and Background Observability

**Purpose:** Make completed/background TaskRuns inspectable without turning the app into a project-management UI.

### Task 4: History Summary

**Files:**
- Modify: `src/renderer/modules/turn-view-renderer.js`
- Modify: `src/renderer/styles/runtime-chat.css`
- Test: `scripts/test-turn-view-renderer.mjs`

- [x] **Step 1: Add render helper**

Add `taskRunSummaryForView(taskRun, translate)` as a pure function:

```js
export function taskRunSummaryForView(taskRun, translate = t) {
  if (!taskRun) return "";
  const evidence = Array.isArray(taskRun.evidence) ? taskRun.evidence.length : 0;
  const risks = Array.isArray(taskRun.risks) ? taskRun.risks.length : 0;
  const verification = taskRun.verification?.status || "";
  return translate("task.summary.compact", {
    status: taskRun.status || "completed",
    evidence,
    risks,
    verification,
  });
}
```

- [x] **Step 2: Render only sealed summary**

In sealed turn render path, if `liveTurn.taskRun` or `record.meta.taskRun` exists, add a compact `details` block below process and above narrative. Keep it collapsed by default.

- [x] **Step 3: Test pure helper**

Add to `scripts/test-turn-view-renderer.mjs`:

```js
assert.equal(
  taskRunSummaryForView(
    { status: "completed", evidence: [{}, {}], risks: [{}], verification: { status: "verified" } },
    (key, p) => `${p.status}/${p.evidence}/${p.risks}/${p.verification}`,
  ),
  "completed/2/1/verified",
);
```

- [x] **Step 4: Run tests**

```bash
node scripts/test-turn-view-renderer.mjs
npx electron scripts/test-renderer-import.cjs
npm run test:unit
```

Expected: all pass.

**No-Dumber Gate:** If rendering throws, catch locally and omit the TaskRun summary. Never block sealed answer rendering.

### Task 5: Background/Scheduled Task Aggregation

Status: deferred by design. Existing scheduled task execution does not need a new persistence model for this change, and adding one now would increase platform surface area without improving the core OpenCode turn path.

**Files:**
- Modify: `src/main/scheduled-tasks.js` only if existing run records can safely store optional TaskRun summary.
- Modify: renderer scheduled task list only if already present and testable.
- Test: `scripts/test-scheduled-tasks.mjs`

- [ ] **Step 1: Prefer no main-process change**

First check whether scheduled task list already reads turn records. If not, do not introduce a new persistence model yet.

- [ ] **Step 2: If adding metadata, make it optional**

Only store:

```js
run.taskRunSummary = {
  status,
  livenessStatus,
  evidenceCount,
  riskCount,
};
```

Never store full tool results or assistant text in scheduled task run rows.

- [ ] **Step 3: Test backward compatibility**

Existing scheduled task JSON without `taskRunSummary` must load unchanged:

```js
assert.equal(manager.list()[0].lastRun.taskRunSummary, undefined);
```

**No-Dumber Gate:** Scheduled task execution and permission mode must remain exactly as today. TaskRun summary must be display-only.

---

## Execution Order

1. Phase 1: Plan fusion from `todo.updated`.
2. Phase 2: Safe recovery metadata and strip annotation.
3. Phase 3: Task-type verification policy.
4. Phase 4 Task 4: Sealed turn TaskRun summary.
5. Phase 4 Task 5: Background/scheduled aggregation only if it stays small.

Do not start with recovery UI. Recovery UI before safe replay metadata is dangerous because it invites users to repeat side effects.

---

## Commit Strategy

Use small commits:

```bash
git commit -m "feat: fuse task run plans"
git commit -m "feat: track task run recovery safety"
git commit -m "feat: classify task run verification"
git commit -m "feat: show task run history summary"
```

Only push after:

```bash
npm run test:unit
```

passes.

---

## Self-Review

Spec coverage:

- Smarter platform: plan fusion and task-type verification.
- Long-running observability: liveness already exists; this adds plan/recovery/history visibility.
- No platform regression: every phase is fail-open and has explicit guard tests.
- OpenCode factor: no OpenCode fork, no change to runner primary execution, only derived platform metadata.

Placeholder scan:

- No “TBD” or “implement later” tasks.
- Each phase has exact files, core code shape, tests, and expected commands.

Risk:

- The only high-risk area is safe recovery. Keep it metadata-only first. Do not add a “retry” button until side-effect detection has been proven and reviewed.
