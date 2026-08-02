# Durable Long Task Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lily execute and recover scoped agentic tasks for tens of hours through durable worker stages and progress-based reasoning leases.

**Architecture:** Replace the process-job JSON registry with a scoped SQLite store, signed per-turn capabilities, process identity fencing, and a main-process reconciliation/wakeup supervisor. Keep OpenCode turns progress-bounded while moving deterministic long work into durable workers.

**Tech Stack:** Electron main process, CommonJS Node.js, built-in `node:sqlite`, OpenCode MCP, existing durable turn admission, Node/Electron test scripts.

---

### Task 1: Durable Store And Scope Capabilities

**Files:**
- Create: `src/main/long-task/store.js`
- Create: `src/main/long-task/scope-token.js`
- Create: `scripts/test-long-task-store.mjs`
- Create: `scripts/test-long-task-scope.mjs`

- [x] Write failing tests for WAL-backed concurrent creation, immutable scope,
  CAS versions, fencing leases, terminal immutability, expired/forged tokens and
  cross-scope invisibility.
- [x] Run both tests and confirm they fail because the modules do not exist.
- [x] Implement schema migration, repository methods and HMAC capability issue/
  verify with constant-time signature checks.
- [x] Run both tests and confirm all assertions pass.

### Task 2: Durable Process Job Runtime

**Files:**
- Create: `src/main/long-task/process-identity.js`
- Create: `src/main/long-task/log-policy.js`
- Modify: `src/main/mcp/process-jobs-core.js`
- Modify: `src/main/process-tree-kill.js`
- Modify: `src/main/mcp/process-jobs-mcp.js`
- Test: `scripts/test-process-jobs-core.mjs`
- Create: `scripts/test-process-job-hardening.mjs`

- [x] Write failing tests for scoped CRUD, process fingerprint mismatch, POSIX
  process-group stop, bounded log rotation, real-progress heartbeat and legacy
  JSON migration.
- [x] Run tests and confirm the new security/reliability assertions fail.
- [x] Route production operations through the SQLite store, persist launch
  identity, rotate logs, and terminate complete process trees.
- [x] Keep explicit test-only legacy adapters so old fixture tests remain useful.
- [x] Run process-job tests and confirm all pass.

### Task 3: Protected Per-turn Capability Injection

**Files:**
- Modify: `src/main/session-runner-pool.js`
- Modify: `src/main/process-job-protocol.js`
- Modify: `src/main/mcp-config.js`
- Modify: `src/main/turn-orchestrator.js`
- Test: `scripts/test-process-job-protocol.mjs`
- Create: `scripts/test-process-job-session-isolation.mjs`

- [x] Write failing tests proving each turn receives a short-lived token bound to
  host-derived owner/session/project/turn and another conversation cannot use it.
- [x] Implement secret provisioning, protected guidance injection and MCP token
  verification without accepting caller-supplied scope fields.
- [x] Run protocol, isolation and runner tests.

### Task 4: Progress-based Long-turn Lease

**Files:**
- Modify: `src/main/opencode-agent-session.js`
- Modify: `src/main/opencode-turn-liveness.js`
- Test: `scripts/test-opencode-agent-session.mjs`
- Create: `scripts/test-long-turn-virtual-clock.mjs`

- [x] Write a virtual-clock test that advances a progressing turn through 48
  hours and proves it remains active, then advances through true no-progress and
  proves bounded recovery/termination.
- [x] Remove the default absolute one-hour cap; retain optional administrative
  deadline and all no-progress, lease, health, loop and depth protections.
- [x] Run liveness and OpenCode session tests.

### Task 5: Reconciliation And Exactly-once Wakeup

**Files:**
- Create: `src/main/long-task/supervisor.js`
- Create: `src/main/long-task/wakeup.js`
- Modify: `src/main.js`
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/turn-admission-runtime.js`
- Create: `scripts/test-long-task-recovery.mjs`
- Create: `scripts/test-long-task-wakeup.mjs`

- [x] Write failing tests for live reattachment, missing-process classification,
  fencing takeover, sleep/resume reconciliation, exactly-once wake events, busy
  conversation queueing and retry after admission failure.
- [x] Implement the main-process supervisor and durable continuation admission.
- [x] Wire startup, shutdown and OS resume notifications.
- [x] Run recovery, queue, scheduled-task and wakeup tests.

### Task 6: Resource And Migration Closure

**Files:**
- Modify: `src/main/mcp/process-jobs-core.js`
- Modify: `src/main/support-diagnostics.js`
- Modify: `CAPABILITY-GATE.md`
- Create: `scripts/test-long-task-resource-policy.mjs`
- Create: `scripts/test-long-task-migration.mjs`

- [x] Write failing tests for log/disk quotas, bounded retention, corrupt legacy
  registry handling and diagnostics without secret leakage.
- [x] Implement quotas, pruning, one-time migration and safe diagnostics.
- [x] Register the long-task failure vectors in the capability gate.
- [x] Run all long-task and architecture tests.

### Task 7: Final Verification

**Files:**
- Test: all `scripts/test-long-task-*.mjs`, process-job, OpenCode, queue and
  architecture guards.

- [x] Run `git diff --check`.
- [x] Run the focused long-task/recovery suite.
- [x] Run `node scripts/test-character-worlds-capability-gate.mjs` and all
  capability registry guards.
- [x] Run `npm run test:unit` with permissions required for loopback/Electron.
- [x] Re-read this plan and design line-by-line; report any unmet requirement as
  incomplete rather than closing the task.
