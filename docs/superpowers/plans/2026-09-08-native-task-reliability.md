# Native task reliability implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Preserve unrelated working files.

**Goal:** Repair confirmed continuity, acceptance and recovery defects without replacing the native agent loop.

**Architecture:** Native OpenCode remains the only model/tool executor. Reuse durable turn inputs as original-request authority, existing acceptance receipts and scoped recovery admission. No new mandatory model round trip, UI, generalized requirement database or DAG scheduler.

**Tech Stack:** CommonJS host modules, Node assertion scripts, SQLite, existing Electron integration tests.

## Approved scope and sequencing

The user approved the narrowed direction after the Claude/Codex comparison. This plan supersedes the broader proposed requirement-ledger implementation in the earlier design; that document is an audit backlog, not a completion claim. Work proceeds incrementally with explicit residual limits. No remote push or release in this task.

### 1. Recover expired parent-closure leases

Files: `src/main/parent-closure-recovery-runtime.js`, `src/main/store/parent-closure-recovery-store.js`, `src/main/session-parent-closure-recovery.js`, existing runtime shutdown wiring; new `scripts/test-parent-closure-lease-resume.mjs`.

- [x] Reproduce claim → crash → restart before expiry using the real SQLite store and controlled timers. Existing startup listing excludes future claims, so no later dispatch occurs.
- [x] Include future claimed candidates in recovery discovery without making them claimable early. Schedule the earliest expiration per session, re-read authoritative state when fired, and clear timers on shutdown.
- [x] Assert one dispatch after expiration, none before, none after owner change/session deletion/explicit interruption/shutdown. Preserve stable recoveryTurnId and existing admission reconciliation; never replay an unknown external action.
- [x] Run `node scripts/test-parent-task-closure-persistence.mjs`, `node scripts/test-parent-task-closure-recovery.mjs`, and the new regression. Inspect integration wiring and architecture ratchets.

### 2. Preserve original request across continued tasks

Files: `src/main/turn-intelligence.js`, `src/main/intent-contract.js`, `src/main/task-core-contracts.js`, `src/main/task-original-acceptance.js`; small source-resolution helper if needed; new `scripts/test-task-request-continuity.mjs`.

- [x] Reproduce a request longer than 1,500 characters whose last obligation disappears from `originalAcceptance` after “继续”. Use the production classifier, archived contract and TaskCore envelope.
- [x] Persist a host-owned source turn reference, not another copy of raw history. Resolve full original input only from the same session/owner/project. Keep bounded objective summaries and native prompt budgets unchanged.
- [x] Carry the reference through normalization/model refinement/TaskCore. Add narrowly scoped polite continuation handling; do not default all short messages to continuation.
- [x] Assert original tail retained, missing source stays explicitly unknown rather than verified, unrelated chat/new task cannot inherit, and forged foreign source cannot be read. Run intent, task-core, original-acceptance and orchestrator regressions.

### 3. Repair execution classification and background-source parity

Files: `src/main/parent-task-closure.js`, `src/main/long-task/session-wakeup.js`, source resolution at `src/main/task-core-runtime.js` / `turn-orchestrator.js`; existing task and wake tests.

- [x] Add production-classifier tests for document/media creation and read-only document questions. Creation must reach objective acceptance; reading must not start artifact repair.
- [x] Replace obsolete document/media type checks with canonical types while retaining the mutation check.
- [x] Resolve trusted sourceTaskCore from the admitted sourceTurnId at the common host boundary, so live background wake and restored queues have the same contract/identity. Reject contradictory session/owner/turn/project metadata; unavailable optional source keeps baseline execution.
- [x] Run `node scripts/test-long-task-session-wakeup.mjs`, `node scripts/test-turn-queue-recovery-task-core.mjs`, `node scripts/test-task-objective-coverage.mjs`, and relevant orchestrator tests.

### 4. Resume exact-repeat observation after closed code

Files: `src/main/turn-loop-guard.js`, optional bounded streaming text helper; `scripts/test-turn-loop-guard.mjs`.

- [x] Reproduce closed fenced code followed by the same two prose sentences repeatedly, including split fence chunks.
- [x] Track fenced regions incrementally; exclude code/quotes/structured lines, resume ordinary prose after known boundaries. Uncertain/oversized input fails open. Do not strip counters or claim semantic-loop detection.
- [x] Assert valid long code, user-requested repetition, foreground tools and pending permissions are not stopped. Existing partial-output, abort and no-parent-reentry behavior remains unchanged.
- [x] Run loop, job observation, task execution progress and native session regressions.

### 5. Verification and handoff

- [x] Review changes for spec compliance, then code quality. Correct findings and re-run affected tests.
- [x] Register changed capability guards, run architecture/registry checks and the relevant integration suite. Do not raise size baselines to conceal growth.
- [x] Record exact tests, skips and residual limits. Real-model success rate, actual installed-client acceptance, deployment, semantic loop detection and generalized requirement-extraction correctness require separate evidence; never infer them from deterministic tests.
## Execution evidence — 2026-09-08

- Production wiring uses the shared source-turn resolver for explicit, admitted and restored queue identities. Missing/foreign sources cannot inherit the latest unrelated task; the real acceptance wrapper retains unknown even without tools or recognized execution intent.
- Original text stays in existing durable admissions. TaskCore carries bounded host-only references and the original mutation operation. SQLite close/reopen preserves full original instructions; optional lineage-helper failure keeps the native task contract and marks source coverage unknown.
- Lease expiration uses one timer per session and rereads authoritative state. Transient scan/source-read failures receive at most two delayed retries, two minutes apart; persistent failure retains durable identity and stops automatic retries. Owner/session/cancellation/disposal fence delayed callbacks.
- Reproductions were observed failing before each main repair: truncated original requirements, creation type alias mismatch, recovered operation loss, closed-fence repetition, missing source coverage, optional helper demotion, and restart/expired-lease read failures.
- Spec review passed after correcting missing-source identity paths and the no-tools completion wrapper. Quality review identified the transient-read lost wakeup; its repair passed final independent recheck with no remaining must-fix findings in this scope.
- All 39 selected scripts below exited 0. This is a focused regression set, **not** the entire `npm run test:unit` suite. `git diff --check` passed. Architecture check: 1,001 source files, 52 ratchets; no baseline increases. Registry check: 75 gates and 75 unique anchors.
- Logs include deliberately injected DB/network/model failures, test-environment missing userData warnings, and Node's SQLite experimental warning. They are not live customer-service failures.

Run individually as `node scripts/test-<name>.mjs`:

```text
architecture-boundaries
capability-gate-registry
intent-contract
job-observation
job-observation-packaging
long-task-session-wakeup
loop-detector
opencode-agent-session
opencode-session-policies
parent-closure-lease-resume
parent-task-closure-persistence
parent-task-closure-recovery
process-job-turn-guard
task-acceptance-recovery
task-completion-integrity
task-completion-multistage
task-context-registry
task-continuation-handoff
task-contract
task-core-contracts
task-core-persistence
task-core-runtime-event-context
task-execution-classification
task-execution-progress
task-lifecycle-runtime
task-lifecycle-store
task-objective-coverage
task-original-acceptance
task-request-continuity
task-run-kernel
task-run-policy
task-source-resolution
task-summary-localization
task-type-schema
task-verification-shell
turn-loop-guard
turn-orchestrator
turn-orchestrator-steer
turn-queue-recovery-task-core
```

### Residual limits / handoff

- No full-app restart/UI run, signed installer, physical two-machine or real-model complex-task benchmark was performed for this refactor. Main-process changes require a full app restart before real-client verification.
- The repetition guard detects confirmed exact prose/poll repetition, not all semantic loops. Protected/ambiguous/oversized text intentionally keeps baseline behavior.
- Request lineage is bounded to 32 source turns; missing history or exceeded bounds remains unknown. This is not a semantic requirements ledger: automatic withdrawal/reconciliation of every historical criterion and perfect natural-language classification are not claimed.
- Persistent recovery-store failure beyond the two delayed retries needs a later explicit resume/restart after the store recovers; it is not treated as successful recovery. Unknown external effects are not replayed.
- OpenCode remains the only executor. No new UI, mandatory model round trip, generic DAG or prompt-budget reduction.
- Changes remain local and uncommitted on `feat/opencode-engine`. No push, deployment or release in this task. Pre-existing untracked output/release files are untouched.

## Follow-up audit repairs — 2026-09-08

The subsequent audit invalidated the earlier review's completeness claim: live recovery exceptions could relinquish ownership and trigger competing self-heal, live claimed failures lacked wakeups, and summary-only document/media continuation still lost creation semantics. These paths were not covered by the initial 39-script set.

- Initial classification now supplies the semantic operation to the intent contract. Production compaction/summary-only continuation preserves document/media creation; read-only continuation remains non-mutating.
- Once a durable recovery claim is attempted, an exception retains recovery ownership. Existing claims and admissions suppress competing self-heal. Negative receipt acknowledgements are not reported as successful dispatch.
- Live failures schedule authoritative reconciliation under the original stable turn identity. A response arriving after lease expiry receives a delayed wakeup too; already-admitted sends are reconciled rather than resent. Cancellation generation and disposal prevent late callbacks from rearming recovery.
- `test-parent-closure-live-failure.mjs` uses real SQLite plus controlled transport/timers: lookup failure, thrown/rejected receipt, lost send response, response after lease expiry, cancellation during send and disposal during send. It checks real `afterParentClosureTerminal` self-heal suppression, durable identity/status, duplicate terminal handling and send count. The original failures were observed before repair; the expiry case was added after independent review found it.
- `test-task-execution-classification.mjs` additionally checks production intent compaction → summary continuation → acceptance without TaskCore; original false execution classification was observed before repair.
- Focused verification expanded to the earlier 39 scripts plus `test-parent-closure-live-failure.mjs` (40 scripts, not the full unit suite). Full app, real model and installed-client acceptance remain unperformed; no release claim is made.
- Independent follow-up review additionally exposed an expired timer being cleared by the scan's final future-lease refresh. The scheduler now preserves that reconciliation only while its authoritative source recovery is still claimed. Eight fault cases pass, including both live and scan late-response cases completing solely via their timer without another terminal event.

### Source-control handoff

After implementation, the user explicitly requested commit and push. The 40 focused scripts were rerun successfully before staging. Source-control handoff is authorized; version bump, installer publication and server deployment are not part of this request. Earlier "uncommitted / no push" notes describe the implementation-stage boundary, not a prohibition on this subsequent handoff.
