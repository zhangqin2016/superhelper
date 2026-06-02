# Turn Event Architecture

This document defines the message lifecycle for the desktop AI workbench.
The goal is to make chat rendering, turn state, queue dispatch, and recovery
deterministic enough that the UI cannot get stuck in a half-finished state.

## Goals

1. Use one transcript mutation source: `assistant:session-events`.
2. Use one busy/capability source: `assistant:turn-state`.
3. Treat every turn ending path identically: completed, error, interrupted, and stalled.
4. Dispatch queued messages only after the previous turn has been finalized.
5. Keep renderer state as a projection of main-process events, not a second state machine.
6. Test each terminal turn outcome and queue handoff.

## Non-goals

- This does not change the engine protocol itself.
- This does not redesign project/session persistence.
- This does not remove streaming/tool IPC yet. Text deltas and tool cards can remain
  live events, but committed transcript mutations must go through session-events.

## Authority Model

### Transcript Authority

The persisted session held by `SessionManager` is the durable source of truth.
The renderer updates the visible transcript only from ordered
`assistant:session-events` batches:

- `user-committed`
- `turn-ended`

Legacy transcript events such as `assistant:user-message` must not be emitted.
Live streaming events may update an in-flight assistant bubble, but the final
assistant message is materialized by `turn-ended`.

### Busy Authority

`TurnController` is the only authority for turn phase and send/interrupt
capabilities. The renderer consumes `assistant:turn-state` through `turn-store`
or the existing compatibility wrapper. Renderer code must not infer busy state
from DOM bubbles, pending text, or queue length.

Valid phases:

- `idle`
- `sending`
- `streaming`
- `tool`
- `permission`
- `stopping`
- `closing`

`closing` means engine output collection is done, but transcript boundary and
queue handoff are still being committed. New direct user sends are queued while
the phase is `closing`.

## Turn Lifecycle

### Normal Send

1. `dispatchUserLine` validates session, project, runtime, API key, and content.
2. If the turn is busy or closing, the message is queued and no transcript event is emitted.
3. If the turn can start, `SessionManager` persists the user message.
4. `assistant:session-events` emits `user-committed`.
5. `TurnController` transitions with `userSend`.
6. Main emits `assistant:turn-state`.
7. `AgentSession.send` sends the message to the engine.
8. Streaming/tool/permission live events update transient UI.
9. Any terminal engine path calls the same completion helper.

### Completion Helper

All terminal paths must call a single main-process helper conceptually named
`completeTurnAndMaybeStartNext(ctx, sessionId, payload)`.

The helper must:

1. Move the active turn to `closing` using `TurnController.completeTurn`.
2. Persist the assistant final message when there is one.
3. Build exactly one `turn-ended` event.
4. Finalize the turn using `TurnController.finalizeTurn`.
5. Emit `assistant:turn-state` showing the session is sendable again.
6. Only after finalization, dequeue and start at most one queued message.
7. If a queued message starts, include its `user-committed` event in the same
   ordered `assistant:session-events` batch after `turn-ended`.
8. Emit `assistant:done` as a compatibility signal, not as transcript authority.

The queue handoff is after finalize, never while the previous turn is still
`closing`. This prevents the next `userSend` from being rejected by phase checks
or inheriting stale turn state.

### Terminal Outcomes

Every terminal outcome uses the same helper:

- `completed`: final assistant output is normal.
- `error`: final assistant output is sanitized and marked failed.
- `interrupted`: may persist partial output; no scary error if no output.
- `stalled`: may persist partial output; no scary error if no output.
- `send_failed`: no engine turn started; user message should be rolled back or
  represented as a failed send outside the transcript.

### Priority Send

Priority send is the "interrupt and ask this instead" path. It is intentionally
not a direct state-machine bypass.

1. Validate the new message against the same send blockers as a normal send.
2. Clear the current session queue.
3. Enqueue the new message as the only pending item.
4. Transition the active turn to `stopping` and interrupt the runner.
5. Let the active turn end through the normal `interrupted` boundary.
6. Only after `finalizeTurn`, dispatch the queued priority message.
7. Emit the interrupted `turn-ended` event before the priority
   `user-committed` event.

This preserves transcript order while giving the user the effect of replacing
the current answer with a more important follow-up.

## Event Contracts

### `user-committed`

Emitted only when a user message has been persisted.

```json
{
  "type": "user-committed",
  "sessionId": "session-id",
  "text": "user text",
  "files": null,
  "fromQueue": false,
  "immediate": true
}
```

### `turn-ended`

Emitted only after the engine turn has reached a terminal outcome and any
assistant message has been persisted.

```json
{
  "type": "turn-ended",
  "sessionId": "session-id",
  "turnId": "turn-id",
  "endReason": "completed",
  "interrupted": false,
  "stalled": false,
  "hadOutput": true,
  "assistant": {
    "text": "assistant text",
    "failed": false
  }
}
```

`assistant` may be `null` for interrupted/stalled turns with no useful output.

## Renderer Rules

1. Apply `assistant:session-events` batches in sequence order.
2. Drop out-of-order or duplicate sequence batches.
3. Render `user-committed` as a durable user bubble.
4. Render `turn-ended` by replacing/removing the live assistant turn UI and
   appending the durable final assistant bubble if present.
5. Use `assistant:turn-state` to update composer enabled/disabled state.
6. Do not use `assistant:done` or `assistant:error` to append transcript bubbles.
7. Existing `assistant:chunk` can update live markdown only.

## Queue Rules

1. Queue while the active session is not sendable, including `closing`.
2. Queue state is UI metadata only, not transcript authority.
3. Dequeue only after `TurnController.finalizeTurn`.
4. Start at most one queued message per boundary.
5. If starting a queued message fails, requeue it at the front and emit
   `assistant:queue-dispatch-failed`.
6. Queueing is per session. A busy session does not force other sessions or
   workspaces to queue.

## Tool Leases

The runner owns tool execution leases because it is the only layer that sees
engine `tool_use` and `tool_result` events.

Rules:

1. Every tool gets a lease when `content_block_start` or full `tool_use`
   arrives.
2. Shell tools (`Bash`, `Shell`, `RunCommand`) are blocking by default.
3. A blocking tool lease prevents idle/message-stop auto-completion.
4. The lease is released only when the matching `tool_result` arrives.
5. Explicitly detached shell commands are marked detached and do not block turn
   completion after their command input is known.
6. Detached detection is conservative: `nohup`, `setsid`, `disown`, or a
   standalone trailing shell background `&`.

This keeps a foreground script in the current session busy, so a second message
to that same session queues instead of being sent as a new turn. Detached
commands are treated as background work and should not hold the chat hostage.

## User-Visible Wait Safeguards

Long waits must be explainable in the UI. The app should avoid silent states
where the user cannot tell whether work is running, queued, recovering, or
stuck.

Current safeguards:

1. Image sends show a preflight toast before vision translation begins.
2. Foreground shell tools emit a long-running progress notice after 30 seconds.
3. Interrupt fallback completes the turn and restarts the dirty CLI process so
   late output cannot leak into the next turn.
4. The renderer runs a lightweight active-session turn-state watchdog to
   re-calibrate controls if an IPC state update is missed.
5. Recovery and queue events remain per session; other sessions can continue.

## Tests

Required coverage:

1. Completed turn finalizes to idle and emits one `turn-ended`.
2. Error turn finalizes to idle and emits a failed `turn-ended`.
3. Interrupted turn finalizes to idle and does not duplicate assistant output.
4. Stalled turn finalizes to idle and does not block send.
5. Queued message starts only after previous turn is finalized.
6. Queued user message appears after previous `turn-ended` in the same ordered
   session-events batch.
7. Renderer ignores `assistant:done` for transcript materialization.
8. Direct send during `closing` queues rather than returning a hard busy error.
9. Running shell tool leases block auto-completion until `tool_result`.
10. Detached shell commands do not block auto-completion once recognized.
11. Long-running shell leases emit a visible progress notice.
12. Interrupt fallback terminates the dirty runner after ending the turn.

## Migration Plan

1. Keep compatibility IPC events temporarily.
2. Move queue handoff after `finalizeTurn`.
3. Ensure all done/error/interrupted/stalled paths use the same boundary helper.
4. Remove renderer transcript mutations from legacy events.
5. Remove legacy `runningSessionIds` once all UI reads `turn-store`.
