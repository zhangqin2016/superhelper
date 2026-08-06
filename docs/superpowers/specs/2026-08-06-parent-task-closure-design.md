# Parent Task Closure Recovery

## Problem

Lily can receive successful tool results and still terminate before the parent
agent produces a final answer. The current failure projection explains the
incomplete turn, but it does not resume the original work. This is especially
bad for code, packaging, deployment, document, and other execution tasks:
inspection and planning may finish while the requested mutation or
verification never happens.

## Goal

When an execution task has durable tool activity but no completed parent
answer, Lily automatically gives the same OpenCode session one bounded
continuation opportunity. The continuation must use the original workspace,
conversation, task contract, and tool results. A second incomplete outcome is
terminal and is reported honestly with recovery evidence.

## Non-goals

- Do not retry ordinary chat, research-only answers, permission waits, or user
  interruptions.
- Do not replay a completed task or rerun arbitrary side effects indefinitely.
- Do not create a second visible user message for the internal continuation.
- Do not replace the existing tool-call rescue, model self-heal, or queue
  recovery mechanisms.

## Contract

An internal parent-closure recovery is eligible only when all conditions hold:

1. The task contract is active and represents execution intent (code, bugfix,
   UI, server, runtime, config, release, architecture/agent implementation,
   or an equivalent mutation task).
2. The turn ended as stalled or failed without an explicit user interruption.
3. The turn has at least one completed tool result, or a running/failed tool
   that proves the agent entered execution.
4. No permission, question, or hook response is waiting for the user.
5. The same source turn has not already received a parent-closure recovery.

The continuation is not considered a success merely because it was sent. The
normal terminal pipeline must receive the resumed turn's final answer and
verification evidence. If that turn also stalls/fails, the normal terminal
summary is emitted and no third attempt is made.

## State machine

```text
running
  -> closure_pending   (eligible incomplete parent turn)
  -> recovery_dispatch (one idempotent internal continuation)
  -> running           (new turn, same session/workspace)
  -> completed         (normal finalization)
  -> failed/stalled     (one recovery exhausted or unavailable)
```

The recovery key is `parent-closure:<sessionId>:<sourceTurnId>`. It is recorded
in the SQLite-backed `parent_closure_recoveries` state machine before the
original terminal projection. The database CAS is the authority across
duplicate engine events and application restarts; the process-local ledger is
only the fail-open compatibility path for lightweight embedders. Each key has
a deterministic continuation turn id, so a crash after admission can be
reconciled without creating a second execution. The source turn id is passed
into the new turn as `sourceTurnId`; the immutable task core is rehydrated from
`turn_inputs` rather than duplicated into the recovery row. The continuation
has `recordUser:false`, so it is not presented as a new user request.

On startup, prepared or expired-claim recovery rows are scanned after normal
turn/queue restoration. If the deterministic continuation already exists, Lily
marks the source recovery as dispatched and does not call the engine again;
otherwise it claims the row with a lease and dispatches the continuation in
the original session. A live claim is never stolen, and a completed or
unavailable recovery is terminal for that source turn.

## Continuation prompt

The engine receives a short corrective instruction, not a fabricated result:

- continue the original request from the existing tool results;
- do not repeat inspection or only describe a plan;
- finish remaining edits/build/package/deploy/verification steps;
- inspect current files before mutating them to preserve idempotency;
- report what changed, what was verified, and any hard blocker.

The original user objective is included for grounding and is bounded before
injection. The engine's existing resumed session remains the source of truth
for detailed tool output.

## Observability

Emit `turn.parent_closure_recovery` as a normal progress notice with:

- `phase`: `started`, `dispatched`, `unavailable`, or `exhausted`;
- `sourceTurnId`, `recoveryKey`, and `attempt`;
- compact counts of completed, failed, and running tools;
- no secrets or raw tool output.

This keeps the user informed without exposing internal prompt text. The task
run is marked as recovering and then returns to running when the new turn is
admitted.

## Verification

Focused tests cover eligibility, exclusions, prompt construction, one-shot
idempotency, durable CAS claims, restart persistence, deterministic
continuation IDs, and orchestrator dispatch. Existing full-suite tests must
remain green, including terminal CAS, queue isolation, recovery retries, and
character binding tests.
