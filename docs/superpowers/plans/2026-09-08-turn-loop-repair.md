# Turn loop repair implementation plan

> Execute the user-approved diagnosis and repair scope using test-driven development, with independent review before completion.

**Goal:** Stop confirmed repetitive execution without truncating legitimate evolving work, replaying side effects, or confusing a completed background job with a running one.

**Architecture:** Keep transport activity separate from stable execution evidence. Normalize only known process-job observation metadata; preserve unknown tool results. Add a bounded, turn-local repetition observer at the native event boundary, retain partial output and use the existing bounded abort path. Confirmed-loop terminals must not enter automatic recovery. Keep model/tool capabilities unchanged.

**Tech stack:** Existing Node/Electron CommonJS runtime, Bun plugin, Node assertion scripts; no new dependencies or model calls.

## Task 1 — Latest background-job state

- [x] Add RED tests to `scripts/test-process-job-turn-guard.mjs`: `running → succeeded/exited/failed/cancelled` for the same job cannot remain a running blocker; another running job remains; malformed/error observations cannot clear a blocker.
- [x] Change `src/main/process-job-turn-guard.js` to reduce valid observations by job identity before determining blockers. Terminal receipts must not be overwritten by an older running snapshot. Preserve unknown-outcome honesty.
- [x] Run `node scripts/test-process-job-turn-guard.mjs` and relevant orchestrator tests.

## Task 2 — Stable job observations

- [x] Add tests to `scripts/test-loop-detector.mjs` and `scripts/test-task-execution-progress.mjs`: repeated job status with only `updatedAt`/observation metadata changed remains identical; log growth, progress and terminal transitions remain different; arbitrary tool timestamps remain meaningful.
- [x] Add one bounded shared CommonJS observation helper under `resources/opencode-plugins/lib/`; use it in the plugin and host progress receipts. Do not modify actual job records or hide information from the user/model.
- [x] Run both test scripts and verify plugin loading/config regression.

## Task 3 — Confirmed repetition and termination

- [x] Add `scripts/test-turn-loop-guard.mjs` exercising real session/reducer integration with controlled server transport: fragmented one/two-sentence repetition, repeated status polls, progress reset, independent turns, protected code/quotes, pending user input, active work, duplicate snapshots and kill switch.
- [x] Add `src/main/turn-loop-guard.js`: bounded streaming sentence window, exact repeated units only, minimum evidence, turn-scoped state. Do not use a phrase blacklist or language/model downgrades. User-requested repeated material and structured code/quotes fail open.
- [x] Integrate the observer in `opencode-agent-session.js`; on confirmed repetition retain received output, report the reason, use `_abortWithTimeout`, and suppress late events while aborting. Preserve interruption and next-turn ownership. No tool is automatically replayed or background job killed.
- [x] Fence confirmed-loop terminals out of parent recovery in `parent-task-closure.js`; preserve ordinary recovery. Check terminal metadata propagation.
- [x] Run the new guard plus session, reducer, liveness, continuation, parent-closure, task-progress and architecture tests.

## Acceptance and evidence

- [x] Record RED and GREEN for all three reproduced defects.
- [x] Review spec compliance, then lifecycle/safety/code quality independently; resolve findings.
- [x] Update `CAPABILITY-GATE.md` and record exact commands/results here. No installer/server release is included in this request. Customer-specific causality still requires their transcript/version; deterministic reproduction is not a claim of live customer acceptance.

Chosen over a global task timeout (would truncate useful work) or hiding duplicate UI text (would conceal continued token/tool consumption). The repair acts on confirmed no-progress, not elapsed task duration. A healthy background process is not killed merely because its observer repeats.

## Completed verification — 2026-09-08

- RED then GREEN: repeated text/session termination, timestamp-only job observations/progress budgets, and historical running receipts. Subsequent review tests reproduced abort returning `false`, user-stop/abort races, task-ID reuse, and stale process callbacks before their fixes.
- Expanded within the same bug scope: legacy process producer generation fencing. `node scripts/test-process-job-generation.mjs` passes six controlled stale-callback/health/stop races against real temporary registry IO. The focused helper avoids increasing the existing module size limit.
- `npm run test:capability-gate`: exit 0, **277 test scripts**, log `/private/tmp/lily-loop-capability-gate-final.log`. This run preceded registration of the additional producer generation test; that test was run separately and passed, then registered for future gate runs.
- Final targeted commands: `node scripts/test-process-job-generation.mjs`, `node scripts/test-turn-loop-guard.mjs`, `node scripts/test-capability-gate-registry.mjs`, `node scripts/test-architecture-boundaries.mjs`, and `git diff --check`: all exit 0. Registry: 75 gates/75 anchors; architecture: 998 source files/52 ratchets.
- Final session and orchestrator re-runs both exit 0: `/private/tmp/lily-loop-session-tests-final.log`, `/private/tmp/lily-loop-orchestrator-final.log`. Producer core, MCP, observability, hardening, durable-job and consumer tests also pass.
- First full gate run exposed an existing collaboration lifecycle DOM test double missing `contains()` and focus ownership. Only the test double was corrected; no unrelated production UI changes.
- Independent specification and lifecycle reviews resolved their findings. Final independent producer review found no important remaining issues and reran generation, consumer, core and observability tests successfully.
- Limits: deterministic source/mechanism verification with controlled engine/process boundaries, not a real-model conversation, customer-log reproduction, signed installer, or production rollout. No commit, push, or release performed. Exact repetition detection deliberately fails open for structured/requested content and unknown observations; it is not a guarantee against every semantic loop.
