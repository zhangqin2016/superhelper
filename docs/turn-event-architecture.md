# Runtime Turn Event Architecture

This document defines the current message lifecycle for the desktop AI workbench.
The goal is to make chat rendering, turn state, queue dispatch, session switching,
and recovery deterministic enough that the UI cannot look dead while the assistant
is still working.

## Current Contract

Lily Workbench no longer treats Claude CLI output as a terminal transcript and no
longer uses legacy chat IPC such as `assistant:chunk`, `assistant:done`,
`assistant:session-events`, or `assistant:turn-state` in production code.

The current production chain is:

```text
OpenCode shared serve / official SDK
  -> OpencodeAgentSession / runtime reducer
  -> TurnOrchestrator
  -> RuntimeEventBus
  -> assistant:runtime-events
  -> SessionRuntimeStore
  -> message / turn-view renderer
```

Durable history is loaded separately:

```text
OpenCode session.messages
  + Lily metadata / legacy fallback from MessageStore
  -> session:get-conversation
  -> SessionRuntimeStore.syncCommittedMessages
  -> renderer committed messages
```

Live repair after session switching is loaded through:

```text
TurnOrchestrator.snapshot(sessionId)
  -> assistant:runtime-snapshot
  -> RuntimeEventBus recent events replay
  -> SessionRuntimeStore.applyRuntimeBatch
```

## Authority Model

### Durable Transcript Authority

OpenCode `session.messages` is the durable transcript source for OpenCode-backed
sessions. Lily's `SessionManager` / `MessageStore` owns session metadata,
legacy fallback messages, and product enhancement metadata such as artifacts,
file diffs, process timelines, result blocks, usage summaries, and failure
classification.

`TurnOrchestrator` is the only code path that commits a user turn or final
assistant metadata record into Lily storage during runtime execution:

- user messages are committed before the engine receives the prompt as the Lily
  local view/fallback;
- assistant metadata records are committed only from one terminal turn boundary;
- queued messages are not committed until they actually start as a new turn.

The renderer may show live events before they are fully persisted, but persisted
OpenCode history plus merged Lily metadata remains the canonical source after a
turn is idle. If OpenCode history cannot be read, Lily falls back to local
metadata/legacy messages rather than showing an empty conversation.

### Live Runtime Authority

`TurnOrchestrator` owns the current turn state for each session:

- `phase`
- `turnId`
- queue
- pending permissions
- pending user questions
- pending hooks
- running tools and shell/background leases
- finalization state

`RuntimeEventBus` is the ordered event transport. It assigns per-session sequence
numbers, batches UI delivery, remembers recent events for snapshot replay, and
blocks non-allowed post-terminal events for a finished turn.

`SessionRuntimeStore` is the renderer-side reducer. It consumes only normalized
Runtime Events and exposes the active session projection for UI rendering and the
composer.

The renderer must not infer busy/running state from DOM nodes, visible text,
scroll position, or local queue labels.

## Runtime Events

The renderer currently handles these stable event families:

- `user.committed`
- `turn.started`
- `turn.accepted`
- `assistant.delta`
- `assistant.thinking.delta`
- `assistant.final`
- `content.block`
- `process.event`
- `tool.started`
- `tool.input.delta`
- `tool.input.done`
- `tool.done`
- `permission.requested`
- `permission.resolved`
- `user_question.requested`
- `user_question.resolved`
- `hook.requested`
- `hook.resolved`
- `engine.notice`
- `engine.warning`
- `engine.stderr`
- `usage.updated`
- `queue.updated`
- `prompt_suggestions.updated`
- `session.hydrated`
- `resume.updated`
- `resume.invalid`
- `recovery.scheduled`
- `recovery.started`
- `turn.dispatch_outcome_unknown` (closed recovery projection; no automatic replay)
- `turn.dispatch_blocked` (closed recovery projection; safe to retry)
- terminal events: `turn.completed`, `turn.failed`, `turn.interrupted`,
  `turn.stalled`

Unknown protocol shapes must be normalized into protocol warnings and reported
through runtime diagnostics after sanitization. They must not silently disappear
or mutate transcript state.

## Turn Lifecycle

### Normal Send

1. Renderer calls `assistant:input` with the active session id.
2. `TurnOrchestrator.sendUserMessage` validates the session and content.
3. If the session phase is not `idle`, the message enters the current session
   queue and emits `queue.updated`. No transcript message is committed yet.
4. If the session can start, `_startTurn` creates a new `turnId`, commits the
   user message to `SessionManager`, and emits `user.committed` with that
   `turnId`.
5. Vision/document preflight may enrich the payload. Failure goes through the
   same terminal finalize path.
6. Session bootstrap/rehydrate may prepend local summary context only when Claude
   resume cannot be used.
7. `_startTurn` emits `turn.started` and sends the prompt to the runtime runner.
8. Runtime adapter events are normalized and ingested into `TurnOrchestrator`.
9. `RuntimeEventBus` sends ordered `assistant:runtime-events` batches to the
   renderer.
10. `SessionRuntimeStore` reduces the batch and `message.js` renders committed
    messages plus the live turn article.

If dispatch reaches a point where the durable outcome cannot be confirmed, the
orchestrator emits `turn.dispatch_outcome_unknown`. This is deliberately not a
confirmed `turn.failed`: the request may have reached the engine. The renderer
closes the live turn, releases the composer, and projects one explicit recovery
assistant card marked `outcomeUnknown` / `manualRecoveryRequired`. It never
automatically replays that request. If a confirmed terminal event is present in
the same ordered batch, that terminal event wins and no recovery card is added.
If dispatch is rejected before the engine can receive the request, the
orchestrator emits `turn.dispatch_blocked` instead. This is a confirmed
non-execution state, so the card remains retryable and may be explicitly sent
again by the user.

### Completion

Every terminal path must call `TurnOrchestrator._finalize` exactly once for the
active `turnId`.

The finalizer:

1. moves the phase to `finalizing`;
2. resolves any still-running tool timeline entries to a terminal state;
3. builds a turn archive record;
4. emits `assistant.final` when there is assistant text;
5. commits the assistant record to `SessionManager`;
6. emits exactly one terminal event;
7. clears live turn state and returns the session to `idle`.

Queue dispatch happens only after the previous turn has reached a terminal
boundary and the orchestrator is idle. Starting the queued item commits that item
as a new `user.committed` event with its own `turnId`.

### Interrupt And Priority Send

Normal stop interrupts the active runner, clears the queue unless explicitly told
otherwise, and finalizes the current turn as `turn.interrupted`.

Priority send is `interruptAndSend`:

1. replace the current session queue with the new priority item;
2. emit `queue.updated`;
3. interrupt the active turn without clearing that priority queue;
4. let the interrupted turn finalize normally;
5. dispatch the priority item only after the interrupted turn is idle.

This preserves transcript order while still letting the user replace the current
work with a more important instruction.

## Session Switching

Switching sessions must not stop a running session. A runner is session-scoped;
background work continues even when the user views another session.

When a session becomes visible:

1. renderer calls `session:get-conversation` for the newest page of durable
   messages; main tries OpenCode `session.messages` first, starting an idle
   OpenCode view when a resume id exists and no runner is currently live;
2. `syncCommittedMessages` updates the runtime store;
3. if the session is running or has a live turn, local not-yet-persisted committed
   messages are preserved instead of being overwritten by a stale disk page;
4. `showSessionMessages` activates that session panel;
5. `resumeLiveSessionUi` replays recent runtime snapshot events through the same
   reducer;
6. composer state is derived from `SessionRuntimeStore.canSend/canInterrupt`.

If durable conversation loading fails, renderer keeps the current runtime store
messages and logs a warning. It must not treat load failure as an empty history.

## Renderer Rules

1. Consume only `assistant:runtime-events` for live turn state.
2. Use `session:get-conversation` only for durable history pages.
3. Use `assistant:runtime-snapshot` only as a repair/replay path after switching
   sessions or restoring a running session view.
4. Use `role + turnId` as the stable committed message identity when a message has
   a `turnId`; user and assistant messages from the same turn must both render.
5. Insert late committed messages before the live turn article for that session.
6. Render queue items only as queue metadata inside the live turn, not as committed
   user messages.
7. Do not clear existing runtime messages when history loading fails.
8. Do not append transcript bubbles from terminal compatibility events; terminal
   Runtime Events are the only final turn boundary.
9. Treat `turn.dispatch_outcome_unknown` as a closed recovery projection, not as
   a running turn and not as a confirmed failure. It must release the composer,
   remain visible after reload, and suppress automatic retry.

## Queue Rules

1. Queue only within the current session.
2. A queued item is not transcript history.
3. Stop clears queued items unless the caller is priority-send.
4. Queue flush happens only after a terminal turn boundary.
5. Failed queue dispatch removes the failed item and attempts the next one only
   when the session is idle.

## Diagnostics

Runtime protocol anomalies are sanitized and reported through the diagnostics
pipeline. Reports include protocol shape, event type/subtype, device/app version,
turn phase, and hashes, but not raw prompts, file contents, full tool inputs, or
workspace paths.

Fixtures under `fixtures/claude-runtime/` are the regression contract. New
unknown runtime events found in production should be converted into sanitized
fixtures before behavior is changed.

## Verification

The minimum verification set for runtime/chat changes is:

```bash
npm run test:runtime
npm run test:renderer
```

When service diagnostics, remote config, or deployment descriptors change, also
run:

```bash
npm run test:service
npm run deploy:baota:check
DATABASE_URL=postgres://postgres:root@localhost:5432/lily_integration npm run server:integration
```

## Known Remaining Work

- Plugin and MCP marketplace metadata exists, but full client-side automatic
  install, permission approval, and runtime invocation is a separate product
  loop.
- `AgentSession` remains a large high-risk module. Do not refactor it broadly
  without adding fixtures first.
