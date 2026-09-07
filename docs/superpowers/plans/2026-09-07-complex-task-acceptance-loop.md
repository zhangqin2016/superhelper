# Complex-task acceptance loop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve the existing working tree; no commit, push, deployment or unbounded retries.

**Goal:** Connect incomplete acceptance to bounded recovery, preserve original requirements, inspect structured deliverables and count actual execution progress.

**Architecture:** Extend existing task-run assessment and parent-closure recovery, not a second scheduler. Keep immutable TaskCore as the original contract, native receipts as verification evidence, and the existing continuation caps and permission checks.

**Tech Stack:** CommonJS main process, Node assertion regressions, existing durable session repository.

## 1. Execution progress

- [x] Add failing regressions to `scripts/test-task-execution-progress.mjs`: a new completed execution receipt resets consecutive no-progress attempts; repeated receipt, failed/running work and todo churn do not; total/shared caps still stop.
- [x] Implement a small helper and wire actual engine completion events in `src/main/opencode-agent-session.js`; retain existing todo progress compatibility.
- [x] Run `node scripts/test-task-execution-progress.mjs` and session-policy/session regressions; review spec then code quality.

## 2. Original requirements and structured delivery

- [x] Add regression tests preserving original TaskCore success criteria even when the current model plan says completed or omits requirements.
- [x] Resolve explicit structured output paths relative to the task workspace; inspect JSON, Markdown, empty/missing files without guessing logical labels are files.
- [x] Add a bounded original-objective coverage assessment using existing judge infrastructure where machine criteria cannot establish semantic coverage. Missing or invalid judge evidence remains unverified, never a fabricated pass.
- [x] Run task completion integrity, multi-stage and task-run tests, including real temporary files.

## 3. Acceptance-to-recovery integration

- [x] Reproduce clean-ended execution with missing focused test: current result does not continue.
- [x] Capture final acceptance before state cleanup; persist typed unfinished-work handoff through the existing parent-closure ledger. Avoid racing specialized verification recovery.
- [x] Verify interrupted turns, pending permission/question, duplicate terminal delivery, restarted process and already-recovered turns cannot cause unauthorized or duplicate execution.

## 4. Final verification

- [x] Run targeted integration suites, architecture and capability gates, and review the full new diff.
- [x] Record actual results and remaining environmental/live-client limits here. Do not equate deterministic regression success with guaranteed success on arbitrary complex tasks.

## Verification commands

```sh
node scripts/test-task-execution-progress.mjs
node scripts/test-task-completion-integrity.mjs
node scripts/test-task-completion-multistage.mjs
node scripts/test-task-continuation-handoff.mjs
node scripts/test-parent-task-closure-persistence.mjs
node scripts/test-task-run-policy.mjs
node scripts/test-architecture-boundaries.mjs
```

## Implementation and review notes

- `task-delivery-manifest.js`: shared typed-path normalization and read-only filesystem inspection. MCP input, intent normalization, immutable TaskCore and compact task history preserve `{path}` (spaces and extensionless outputs included). Paths resolving outside the workspace, including symlink ancestors, never qualify for automatic file repair.
- `task-original-acceptance.js`: original/current acceptance union; full user instruction retained alongside the bounded semantic contract. Semantic coverage uses completed tools across todo updates, validates exact original-requirement and successful-output quotes, and never overrides failed native exit receipts. One call capped at 10 seconds; requests over 64,000 characters remain unknown instead of silently truncating. `LILY_OBJECTIVE_COVERAGE=0` disables that call without blocking answer delivery.
- `turn-acceptance-recovery.js`: joins task verification to existing parent closure. Clean productive todo handoffs remain available, specialized verification recovery owns its lane, and failed/non-execution local completions retain synchronous projection.
- Independent spec/quality review findings were reproduced and fixed: both asynchronous stale-turn windows; todo reset losing audit evidence; typed paths lost at real schema/normalization entry; failed wrapper exit aliases accepted as success; original request tail lost to 1,000-character summary. A full orchestrator regression additionally caught delayed local scheduled-draft completion; the non-execution fast path fixes it.
- New recovery integration uses an actual SQLite database, closes/reopens it and verifies exactly one continuation with the full long original request. Test transport/judge responses are controlled; they are not a real-model success-rate measurement.

## Boundaries

Final fresh verification: **37/37 targeted suites passed, zero failures**: task-original-acceptance, task-objective-coverage, task-acceptance-recovery, task-execution-progress, task-completion-integrity, task-completion-multistage, task-verification-shell, task-summary-localization, task-continuation-handoff, parent-task-closure-persistence, parent-task-closure-recovery, task-core-contracts, task-core-persistence, task-core-runtime-event-context, task-run-policy, task-run-kernel, task-contract, task-type-schema, task-lifecycle-runtime, intent-contract, turn-terminal-cas-recovery, turn-terminal-narrative, turn-queue-recovery-task-core, turn-orchestrator, turn-orchestrator-steer, turn-recovery-message-index, turn-runtime-event-router, opencode-session-policies, opencode-runtime-reducer, opencode-agent-session, context-os-long-session, long-task-recovery, agent-guide-i18n, platform-intent-eval, model-eval-policy, architecture-boundaries, capability-gate-registry. Architecture: 993 source files / 52 ratchets. Capability registry: 74 gates / 74 document anchors. `git diff --check` passed. Independent final spec and quality reviews found no remaining P1/P2 in this change. Expected fault-injection/config-unavailable warnings and Node's SQLite experimental warning are not hidden; no full-repository test-suite claim is made.

No commit, push, packaged Mac release, production deployment or fresh real-model GUI acceptance was performed in this implementation turn. Existing dirty changes and unrelated `output/` artifacts are preserved. These changes require a full main-process restart to exercise in the client; renderer-only reload does not load the new host logic. Arbitrary complex-task completion is not guaranteed: unavailable evidence, permissions, external dependencies and bounded retry exhaustion remain explicit non-success states.
