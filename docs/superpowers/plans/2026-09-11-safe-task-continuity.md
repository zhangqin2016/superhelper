# Safe task continuity implementation plan

> Use test-driven development and independent review for each implementation slice.

## Approved direction

The user approved separating task completion from agent-turn and background-job
completion, and explicitly required protection against infinite loops. Reuse the
existing TaskCore, native todo gate and durable parent-closure journal. Do not
create another competing scheduler or silently grant unlimited time/money.

## Safety invariants

- Keep primary/subagent step budgets, shared continuation cap, consecutive
  no-progress cap, parent recovery deduplication, user cancellation and permission
  boundaries. No unbounded recursive recovery.
- A successful new observation may replenish consecutive no-progress allowance,
  never the absolute per-turn allowance.
- A partial report is not proof of task acceptance. Unknown writes are inspected,
  not blindly replayed. Stream EOF is not a successful model finish.
- Use no production credentials, customer records or production deployment during
  regression testing. Preserve unrelated repository changes.

## Slice 1: repair confirmed boundary defects

### Execution progress and bounded handoff

Files: `src/main/task-execution-progress.js`,
`src/main/opencode-todo-completion-policy.js`, new
`scripts/test-task-long-progress.mjs`.

- [x] Add failing real-function tests for more than 1,024 distinct receipts,
  recent identical receipts, failed receipts and unchanged four-claim cap.
- [x] Bound receipt memory with a rolling fingerprint window instead of turning
  off all progress detection once the window fills. This is recent observation
  deduplication, not task acceptance or exactly-once business processing.
- [x] Test productive total-attempt exhaustion versus consecutive no-progress
  exhaustion: only the former can emit the existing single durable handoff.
- [x] Include a machine-readable stop reason and a factual user-visible notice
  distinguishing budget exhaustion from no-progress. Do not claim continuation
  was scheduled until the existing recovery runtime has admitted it.
- [x] Run the new test, session policy, execution progress, handoff, parent
  persistence and acceptance recovery tests.

### Streaming completion integrity

Files: `server/src/services/model-gateway/openai-adapter.js`, a small adjacent
stream helper if needed, new `scripts/test-gateway-stream-completion.mjs`.

- [x] Add failing tests using synthetic Response streams: incomplete EOF,
  explicit finish, fragmented SSE, final line without newline, malformed data,
  and upstream failure. Assert partial text retained and no false success.
- [x] Validate explicit upstream finish evidence before emitting normal
  Anthropic completion. Surface a protocol error on incomplete stream; no replay.
- [x] Preserve existing valid token usage, text, and completion paths.
- [x] Run new regression and existing gateway tests.

## Slice 2: durable task-level execution (separate integration milestone)

Implementation contract: share a durable admission ledger between parent closure
and background wakes. Each original user turn permits at most 8 parent/job continuation rounds
within 24 hours of its first reservation. Reserve before dispatch; unknown sends
are never refunded. Later rounds require new host-observed receipt hashes, not
model progress claims. Preserve original objective/task core, cancellation and
owner checks. Legacy runtimes without this ledger retain single closure recovery.
Test real SQLite restart/idempotency and runtime dispatch denials. Existing job
checkpoints, leases and replay policies remain authoritative; do not replay jobs.

The complete product direction still requires task-root budgets and progress
checkpoints persisted across all admitted rounds; generic recoverable batch jobs
must own queues/checkpoints, leases and idempotent writes. Existing single closure
recovery is deliberately not changed into unlimited chaining in slice 1.
Before implementing this milestone, trace current process-job and task-journal
contracts and establish integration tests for restart, cancellation, repeated
progress claims, duplicate callbacks, unknown writes, owner changes and terminal
acceptance. No claim that repairing slice 1 implements this milestone.

Slice 2 implementation now includes shared SQLite admission claims, host receipt
snapshots before runner reset, durable parent recovery and job-wake integration,
original source/task-core retention, dispatch-time cancellation revalidation,
and a durable stop epoch covering jobs whose source already finished. Specialized
rescue ancestry is followed through immutable direct-admission source records
and the protected queue envelope so it cannot
reset the shared budget. Existing specialized retry bounds remain separate.
The 8-round/24-hour values are conservative defaults, not a promise that every
task can complete within them. Receipt uniqueness is a liveness signal, not
semantic acceptance or exactly-once business side effects.

Batch work uses the existing durable process runtime. Guidance now explicitly
requires the worker to own its whole authorized queue and committed checkpoints,
and explains inspect versus never wake policy. No universal business-operation
replayer was added: arbitrary writes cannot safely be retried generically.

Review-discovered edge cases were reproduced and repaired: duplicate unadmitted
claims past deadline, sibling wakes after cancellation, idle stop before a first
wake, ordinary queued sources with explicit null parent, direct specialized
rescue lineage, and interrupt-and-send preserving the replacement user root.
Cancellation is rechecked immediately before dispatch, including already queued
continuations. This fences future automatic turns; it does not claim to terminate
every detached operating-system process.

## Validation and release boundary

Run independent spec and code review, targeted regressions and architecture gates.
Document real results, including skips. Customer incident attribution requires the
customer's version and terminal/job logs. Installed-client, real-proxy and 22,280
record unattended acceptance remain separate from deterministic unit tests.
No push, deployment or app restart without the corresponding task scope.

## Implementation evidence

New long-progress test first failed at receipt 1,025; after rolling-window repair,
it failed at productive total exhaustion losing its handoff. Follow-up tests then
failed on invisible answerless reason and the generic stalled-recovery bypass.
All were repaired. Runner-to-orchestrator terminal metadata regression failed
before the stop reason/count propagation fix. Window size remains 1,024; tests
exercise 3,200 fresh receipts plus several long repeated cycles. No absolute cap
or permission boundary was removed.

Streaming tests failed before the EOF repair, then exposed malformed JSON before
valid completion and malformed finish-reason types; each was repaired and
retested. Explicit `length` retains `max_tokens`, not successful `end_turn`.

Independent main-process spec and quality reviews passed. Existing specialized
evidence/document recovery is still separately bounded; `no_progress` blocks
parent closure, not every recovery mechanism in the system. Do not describe this
slice as an unlimited unattended execution system or customer incident closure.

Stream spec and code-quality reviews also passed, including a still-open malformed
upstream cancellation/reader-release check. Existing gateway buffering/backpressure
and client-disconnect policy was not redesigned in this slice.

Fresh validation: 20 targeted scripts passed (long progress, execution progress,
session policies, continuation handoff, parent closure recovery/persistence,
acceptance recovery, orchestrator, agent session, repetition guard, process-job
guard, lease resume, live recovery failures, completion integrity, registry,
architecture, stream completion and three gateway suites). Registry: 82 gates;
architecture: 1,013 source files / 52 ratchets. Fault-injection suites print
expected warnings; the acceptance fixture also reports unavailable learned-skill
collection. Full repository suite, installed UI and real provider acceptance were
not run. No commit, push or deployment was performed.

Slice 2 final verification (2026-09-12): durable budget/store, dispatch, native
execution progress, long progress, handoff, parent recovery/persistence, real
lease restart and live failure injection, acceptance recovery, actual
orchestrator priority replacement, agent session, long-task wake/recovery/scope,
MCP process jobs, original-request/source continuity, queue TaskCore, legacy and
migration admission, external admission, repetition/process-job guards, gateway
completion and the three gateway compatibility suites passed. Capability registry
remains 82 gates; architecture passes with 1,014 source files and 52 ratchets.
Expected fault-injection warnings are not production failures. Whitespace checks
passed. Independent final recheck confirmed direct lineage and replacement-root
cancellation fixes and reported no remaining critical findings in that scope.
Full repository suite, installed-client UI, real provider and customer 22,280-row
unattended run remain unverified. No commit, push, package or deployment made.
