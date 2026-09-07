# Task Completion Integrity Implementation Plan

**Goal:** Repair the audited completion false positives and safely continue an incomplete successful turn without replaying already executed operations.

**Architecture:** Keep the existing engine, durable admission and parent-closure recovery. Separate turn termination from task verification. Derive bounded verification receipts from completed tool executions, never tool titles. Preserve unresolved plan steps. Permit one durable parent-closure handoff after the existing in-turn budget is exhausted only when the engine reports actual progress, no pending user input and no previous closure attempt.

**Tech Stack:** CommonJS main process, Node regression tests, existing Electron runtime projections and SQLite recovery ledger.

Scope approved by the user's instruction to repair all findings in the preceding audit. Work inline; preserve staged IM changes and do not commit or publish them.

## Task 1: Verification evidence

- [x] Add `scripts/test-task-completion-integrity.mjs`. Reproduce `cat tests/config.json` being counted as a successful test, missing artifacts being ignored, and later writes invalidating earlier tests.
- [x] Add a bounded execution-receipt helper and use it in `buildTaskToolEvidence`, `addTaskEvidence`, and `assessTaskVerification`. Require a recognized actual verification invocation and successful execution; unknown receipts remain observed, not verified. Do not evaluate shell text or execute commands during classification.
- [x] Aggregate every required criterion; file changes alone never prove an openable artifact. Keep ordinary answer delivery fail-open.
- [x] Run `node scripts/test-task-completion-integrity.mjs` and `node scripts/test-task-run-policy.mjs`.

## Task 2: Honest terminal progress

- [x] Reproduce pending native todo steps becoming completed despite unverified delivery.
- [x] Preserve native plan statuses and evidence overlays; default scaffold verification remains pending when unverified. Report achieved fraction rather than forced 100%. A legacy terminal event remains compatible, but completionStatus and verification must not claim verified completion with unresolved steps.
- [x] Verify runtime archive and renderer projections continue to distinguish unresolved progress.

## Task 3: Bounded durable continuation

- [x] Reproduce clean partial completion being rejected by parent-closure recovery.
- [x] Have the native todo gate report a bounded unfinished snapshot and progress evidence. Persist these fields with the existing closure recovery record. Permit one closure handoff after progress; exclude user interruption, pending permission/question, no progress, and already-recovered turns.
- [x] Preserve original task core, ownership checks, durable identity and duplicate suppression. The continuation prompt must inspect current state and remaining work, not replay commands or expand authorization.
- [x] Run parent-closure recovery/persistence tests and engine completion tests, including restart, duplicate events and no-progress boundaries.

## Task 4: Acceptance

- [x] Run focused completion, orchestrator, task policy, todo overlay, context, long-task, recovery, evidence and architecture suites.
- [x] Add a deterministic multi-stage acceptance test using actual temporary files/process exit results to verify implementation → verification → later edit → re-verification → missing deliverable → terminal progress.
- [x] Record exact results and remaining live-model acceptance boundary. A simulated engine is not a real-model complex-task success-rate benchmark.

## Verification record

2026-09-07: 36 focused Node scripts passed (completion, continuation, engine adapter, durable recovery, task lifecycle, context, long tasks, evidence, renderer projections and architecture). Capability registry separately passed: 74 gates / 74 documentation anchors; architecture: 988 source files / 52 ratchets. `git diff --check` passed. Independent read-only review found and drove additional regressions for todo metadata invalidation, missing declared deliveries, compound checks and content-extraction early returns. Task durable lifecycle now uses the final, plan-aware verification assessment.

Scope boundary: no full repository suite, packaged Mac acceptance, production deployment or paid real-model benchmark was performed. The multistage check executes real local files/tests but does not prove a model will choose the correct implementation. Unknown shell forms and semantic criteria stay observed/unverified without blocking delivery. Existing bounded retries remain bounded; unresolved work after them is reported, not silently declared complete. No commit or push performed.

### Follow-up acceptance

The follow-up ran the existing curated runtime chain (16/16), renderer chain (14/15 in the sandbox, with the Electron import test subsequently passing outside the sandbox), and service chain (31/32 in the sandbox, with the loopback mail MCP test subsequently passing outside the sandbox). Thus all 63 curated test entries passed across the initial runs and isolated retries; this is not an all-repository suite result. The renderer fixture logs missing optional IPC handlers while still completing its assertions successfully.

Live setup checks inspected presence only, not secret values. `LILY_EVAL_BASE_URL`, `LILY_EVAL_API_KEY`, `LILY_EVAL_MODEL`, and the alternative intent-eval credential/config variables were absent. No private app credentials were extracted and no paid endpoint was called. The current model runner has eight basic cases and explicitly excludes Electron-hosted orchestration; neither it nor the completed deterministic checks establish a complex-task success rate. Live end-to-end acceptance remains pending a configured, authorized test model and bounded test budget. Packaging, publishing and pushing are not silently included in this repair acceptance.

No unlimited retries, no new background authority, no replacing model judgment with a keyword task router, no claim that a file's mere existence proves its semantic quality.
