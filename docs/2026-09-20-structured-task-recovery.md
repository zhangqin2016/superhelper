# Structured task recovery

## Outcome and boundaries

A transient provider failure must retain its native cause and execution receipts,
then enter the existing single-owner recovery path. It must not silently become a
generic error, replay unknown writes, lose progress, or compete with a durable
continuation already admitted. This change is the recovery foundation, not a
claim of complete long-task acceptance or production UI certification.

## Ownership

- `runner-failure.js`: pure normalization of bounded native error envelopes.
  Reads message/name/code/status/retryability and known cause wrappers only.
  Does not serialize requests, credentials, response bodies or tool output.
- OpenCode adapter: preserves the native cause and captures execution progress
  before resetting the completed attempt. Existing specialized context/auth/
  permission repair stays in the adapter.
- Turn orchestrator: forwards the normalized result and progress to both terminal
  persistence and parent recovery; no new retry timers or model judgement here.
- Existing parent-closure runtime/store: owns durable continuation admission and
  restart reconciliation. Transport interruption with tool activity is eligible
  independently of task labels or a minimum count of completed tools.
- Existing rescue: retains bounded no-tool/read-only replay. Explicit
  non-retryable terminal failures do not enter either generic recovery lane.

## Safety invariants

No model, tool, permission or context capability changes. Unknown writes remain
inspect-before-continue; this does not claim transactional exactly-once execution
of arbitrary external tools. User cancellation, pending questions/permissions,
claim identity, confirmed-loop and no-progress gates remain intact. Legacy
string errors and old persisted recovery records remain supported. Specialized
context repair must not be blocked by a generic non-retryable guard.

Persist only failure code/retryability and existing progress keys in the recovery
source, not a full error graph. Restart must use the same recovery turn ID and
must not reclassify the task as a generic stalled analysis with too few tools.

## Verification

Final focused run: 23/23 scripts passed, including the production OpenCode
session and turn-orchestrator harnesses, SQLite restart/lease fault injection,
continuation admission and virtual-clock ownership tests. Syntax checks for all
seven changed/new runtime modules and `git diff --check` passed. This is not the
full repository test suite or a real-model desktop run.

- `test-runner-failure-contract.mjs`: real native adapter/terminal boundary,
  connection phrase from UI failure, nested API errors, errno/status handling,
  auth/context precedence, explicit non-retryability, cycles, excluded request
  credentials, progress before cleanup, one continuation and no competing replay.
- `test-transport-closure-restart.mjs`: real SQLite close/reopen, interrupted
  single-tool document task, persisted failure/progress, stable admission identity,
  inspect-before-continue guidance and duplicate restart scan.
- Existing engine, parent closure, rescue, ownership, continuation, permission,
  model-watch and virtual-clock regressions are retained.

## Remaining work (not enabled by this change)

The acceptance-gap continuation flag remains opt-in. Simply enabling it would
restore a documented repeated-completion loop. A future change needs durable
per-requirement evidence across attempts and a grounded missing-work admission
policy, not a larger retry count or a weaker completion rule. The existing
progress floor and bounded tail-only acceptance audit are unchanged.

Subsequent native Windows fault injection, packaged-client acceptance and the
0.1.182 release are tracked in `2026-09-20-windows-0.1.182-release.md`.
Hour-scale tasks and customer-device reproduction remain unverified; neither
mechanism tests nor minute-scale UI runs certify every long-running task.
