# Task continuity repair implementation plan

**Goal:** Fix the three reproduced audit findings without removing finite automatic budgets or weakening ownership/cancellation fencing.

**Architecture:** Both process observers must persist the final bounded log progress before recording terminal state. Explicit user retry preserves source requirements/persona but starts a new durable budget root; automatic recovery retains ancestry. Abandoned background wakes publish an idempotent, owner-scoped, durable incomplete-task notice, never a fabricated completion or a new model request.

**Tech stack:** Existing Electron main process, CommonJS, SQLite, Node integration tests. Work in the current dirty feature workspace and preserve all previous changes. No deployment or push in this task.

## Execution

- [x] Progress: reproduced 1500 → 3000 through real MessageStore, LongTaskStore, Supervisor and wake handler in `scripts/test-task-continuity-integration.mjs`; both wakes now deliver. Shared bounded progress collection between both process observers preserves fenced writes. Repeated identical receipts still stop and duplicate delivery remains idempotent. A second observation after the terminal marker closes the final-progress race.
- [x] Retry: reproduced an exhausted root through actual retry/admission code. Added an immutable, host-admitted explicit retry root while preserving source links for task/persona inheritance. Direct, busy queued and database-reopened paths agree; automatic recovery and late old jobs remain under their original budgets. Editable metadata cannot reset budgets.
- [x] Visibility: abandoned wakes publish one durable source-associated notice before acknowledgement. Restart retries notice publication, not model execution. Foreign/deleted sessions do not receive it. The existing conversation surface renders a dedicated incomplete-task status, not a completed assistant answer or a new panel.
- [x] Verification executed: regressions were run red before their fixes and green afterward. Existing related suites, Electron DOM checks and architecture checks passed. Full capability-gate execution has one unrelated registry failure described below; it is not a green full-repository acceptance.

## Acceptance

`node scripts/test-task-continuity-integration.mjs` must pass using real temporary SQLite stores, with only the model-send boundary simulated. Existing finite 8-round/24-hour guards remain. Run related tests named in CAPABILITY-GATE.md and register the new integration guard. No changes to provider selection, permissions, customer data or installed applications.

## Verification record — 2026-09-12

- New integration suite: **7/7 passed**, including unchanged progress, restart, real busy-queue admission, manual retry followed by automatic recovery, final-progress interleaving, durable notice deduplication, source-specific text/attachments, and suppressed terminal recovery.
- Independent review found additional queue-option, source-binding and terminal-observation races. They were reproduced and fixed. Final bounded re-review reported no new reproducible issue in the source-binding/suppression paths.
- `scripts/test-renderer-import.cjs`: passed under Electron, including real DOM pause-notice visibility, single rendering, history reload, and absence of false completion controls. Initial sandbox Electron launch failed; the permitted rerun passed.
- 28 related long-task/process/admission/renderer suites passed. After the final recovery changes, continuation dispatch, parent-closure live-failure and lease-resume, orchestrator, character-binding isolation and the new integration suite were rerun successfully.
- `npm run test:architecture`: passed, 1021 source files / 52 ratchets. `git diff --check`: passed.
- Full `npm run test:capability-gate` rerun with required local test permissions finished with **only `test-capability-gate-registry.mjs` failing**: the concurrent `conversation-render-order` documentation anchor has no registry entry. This repair's integration suite is registered under `task-completion-integrity`. Other ongoing renderer changes were preserved, not overwritten. Log: `/private/tmp/lily-continuity-capability-unrestricted.log`.

Limits: no real-provider/customer 22,280-record run, installed Mac release acceptance, commit, push or deployment was performed. Previously abandoned immutable jobs are not automatically resurrected. Passing these regressions does not establish that every arbitrary task can complete within the unchanged automatic budgets.

## Commit/push verification — 2026-09-12

The user subsequently authorized commit and push. The staged snapshot excludes unrelated database-safety and conversation-ordering changes, including their documentation/registry entries; working copies are preserved. The resulting snapshot has no incomplete conversation-ordering gate registration.

- Tested the actual staged snapshot independently under `/private/tmp/lily-continuity-ship.A3rQyP`, explicitly using project Node 22.19.0. An initial attempt selected the temporary directory's older Node and was stopped; it is not counted as validation.
- The first complete snapshot run exposed a stale rescue-test fixture: its durable turn map lacked the production `getTurnInputByTurnId` interface. Added a same-session lookup without weakening production source validation. The full rescue test then passed.
- Final complete capability gate: **305 test scripts passed**, exit 0. Log: `/private/tmp/lily-continuity-staged-gate-final.log`. Includes the actual Electron pause-notice DOM test.
- Snapshot verification also passed all **28 related regression scripts**, **7/7 new integration tests**, and architecture boundaries (**1018 source files / 52 ratchets**). The lower source count excludes unrelated uncommitted modules.
- Independent scoped review found no blocking issue or missing staged dependency. Credential scan reported no findings. Exact code snapshot, rather than the dirty workspace, is the release-independent verification target.

This authorization covers committing and pushing these repairs only, not a version bump, deployment, installed-client acceptance or customer-data execution.
