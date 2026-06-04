# Lily Workbench Experience Stability Roadmap

## Purpose

This document turns the current product stability review into an executable plan.
The goal is not to add more isolated features. The goal is to make every slow,
failed, interrupted, queued, or background operation visible, recoverable, and
diagnosable.

## Product Standard

Lily Workbench should feel like a work assistant, not a hidden terminal wrapper.

For every user action:

- The user sees the action immediately in the conversation or workspace UI.
- The app shows what it is doing now.
- The user can stop, cancel, retry, or continue when the operation is slow.
- Failure messages explain the actionable cause, not internal implementation.
- Session, workspace, queue, and tool events never cross into the wrong context.
- Deployment and licensing failures are detected by health checks before users hit them.

## Current Architecture Baseline

The desktop client already has the right core direction:

- Main process owns execution through `AgentSession`.
- Turn lifecycle is centralized in `turn-controller`.
- Ordered transcript updates go through `session-events` and `turn-boundary`.
- Per-session message queue exists in `turn-message-queue`.
- Renderer busy state reads `turn-store`.
- Shell tool lease tracking exists in `agent-session`.
- Vision preprocessing has resize/compress fallback.
- License, update, plugin registry, usage reporting, and server admin exist.

The remaining work is mostly about closing edge cases and making internal state
visible to users and operators.

## Priority Principles

1. One state source per concern.
   Renderer must consume state; it must not infer whether a session is busy,
   stuck, queued, or recovering.

2. User-visible progress before backend work.
   Messages and attachments should appear immediately. Long preprocessing can
   update the message state later.

3. Completion happens once.
   `completed`, `error`, `interrupted`, `stalled`, and `send_failed` must use
   the same turn completion path.

4. Queue flush only after turn finalization.
   A queued user message must not render before the previous assistant turn has
   been materialized.

5. Every slow path has a timeout and a next action.
   The user must never wait without a visible explanation.

6. Deployment must be self-checking.
   Production should report missing signing keys, old image tags, bad CDN
   release data, or database failures before users discover them.

## Phase 1: Kill Dead-Wait States

### Objective

Make chat, image, tool, queue, stop, and auto-recovery states explicit and
predictable.

### Work Items

1. Add visible task/progress notices for image preprocessing and vision calls.
2. Ensure image messages render immediately before vision translation finishes.
3. Normalize long-running shell feedback:
   - show progress after 30 seconds,
   - keep the session busy while foreground tools have leases,
   - allow detached/background tools to stop blocking the turn.
4. Make auto-recovery visible:
   - recovering,
   - recovered,
   - failed after max retries.
5. Make queue behavior explicit:
   - queued message chip,
   - cancel queued message,
   - interrupt-and-send path for priority user input.
6. Make stop behavior explicit:
   - stop cancels current turn,
   - clears only the current session queue,
   - does not touch other workspaces or sessions.

### Acceptance Criteria

- Sending an image plus text immediately displays the user bubble.
- If vision takes longer than 1 second, the user sees a progress notice.
- If vision fails, the conversation continues with the original image and a
  clear non-blocking notice.
- If a shell command runs longer than 30 seconds, the user sees that work is
  still running.
- A second message sent during an active turn appears in the queue for the same
  session only.
- Stop clears only the active session's running turn and queue.
- Auto-recovery never looks like a frozen chat window.

### Tests

- `scripts/test-image-send-flow.mjs`
- `scripts/test-agent-tool-lease.mjs`
- `scripts/test-turn-message-queue.mjs`
- `scripts/test-interrupt-and-send.mjs`
- `scripts/test-turn-auto-recovery.mjs`
- `scripts/test-session-events.mjs`

## Phase 2: License, Trial, and Update Reliability

### Objective

Make activation, trial, update, and release deployment self-explanatory and
self-checking.

### Work Items

1. Add server health diagnostics:
   - database connectivity,
   - license private/public key presence,
   - signing test,
   - update CDN reachability,
   - API image tag,
   - web image tag,
   - current release version.
2. Add admin health page.
3. Split activation errors:
   - license not found,
   - expired,
   - disabled,
   - seat limit reached,
   - device disabled,
   - service unavailable,
   - server signing misconfigured.
4. Show trial state clearly on first launch.
5. Guard release deployment:
   - refuse publish when API/Web image tags are inconsistent,
   - verify latest release endpoint after publish.

### Acceptance Criteria

- Admin can see why activation would fail before a customer reports it.
- Client activation failures map to user-readable causes.
- Trial days are visible and consistent with server settings.
- Updating release metadata verifies public URLs.

## Phase 3: Workspace Isolation and Expert Growth

### Objective

Make each workspace feel like an independent assistant that grows around a
folder and never mixes state with another workspace.

### Work Items

1. Add workspace-level activity summary:
   - active session count,
   - queued messages,
   - running tools,
   - last update.
2. Verify all events carry `workspaceId`, `sessionId`, and `turnId` where
   applicable.
3. Add workspace context quality indicators:
   - files detected,
   - recent documents,
   - enabled skills,
   - last indexed/used context.
4. Improve workspace switching:
   - preserve scroll and composer state per session,
   - show running indicators in sidebar,
   - never switch active project silently during a background event.

### Acceptance Criteria

- Background activity in workspace A does not alter workspace B's UI state.
- Every visible message belongs to the selected session.
- Sidebar can explain why a workspace is busy.

## Phase 4: Plugin and MCP Closed Loop

### Objective

Turn plugins into a controlled capability layer, not just installable metadata.

### Work Items

1. Add plugin scope:
   - global,
   - workspace,
   - session.
2. Add plugin permission preview before install.
3. Add MCP health states:
   - not installed,
   - installed,
   - missing key,
   - connected,
   - failed.
4. Show tool/plugin cards when the assistant uses a plugin automatically.
5. Report install/update/enable/disable/call events to the server.

### Acceptance Criteria

- Users know what capability a plugin adds and what it can access.
- A failed plugin does not look like a failed assistant.
- Admin can see plugin adoption without collecting chat content.

## Phase 5: Operator-Grade Deployment Flow

### Objective

Make build, upload, deploy, and rollback safe enough to run repeatedly.

### Work Items

1. One command for local release:
   - bump version,
   - build Mac/Windows,
   - upload artifacts,
   - publish release metadata,
   - verify public downloads.
2. One command for server deploy:
   - build API/Web images,
   - upload unique image objects,
   - server downloads from Qiniu,
   - load Docker images,
   - set image tag,
   - restart,
   - health check,
   - smoke test.
3. Add rollback metadata.
4. Add deployment audit entries.

### Acceptance Criteria

- A release cannot silently run an old Docker tag.
- A failed deploy exits loudly with the failing check.
- The admin console shows current live version and last deploy result.

## Phase 6: Question-Answer Stability

### Objective

Make day-to-day chat feel stable even when the model is slow, a session resume
fails, a tool produces too much output, or the user switches workspace while a
turn is running.

### Work Items

1. Turn identity coverage:
   - include `turnId` in chunks, status, tools, notices, errors, and completion,
   - renderer ignores stale turn events for the visible active turn,
   - queued messages start a fresh turn only after the previous boundary.
2. User-visible waiting states:
   - show first-response waiting notice,
   - show long-wait notice before timeout,
   - show recovering/recovered/failed states in the assistant activity area.
3. Resume failure hardening:
   - hide raw `Session ID ... already in use` / resume errors from users,
   - clear stale resume identity,
   - restart the engine context,
   - keep local transcript intact.
4. Tool output stability:
   - cap huge tool output in UI cards,
   - keep raw logs internal or collapsed,
   - summarize long output for model-facing follow-up where possible.
5. Long command classification:
   - detect dev servers, watchers, tails, and other never-ending commands,
   - mark them detached/background when appropriate,
   - stop blocking the chat turn once backgrounded.

### Acceptance Criteria

- A user never waits more than 10 seconds without a visible activity message.
- Slow model start and auto-recovery are distinguishable in the UI.
- Resume failures do not expose raw engine session IDs.
- Tool output cannot flood the chat window or delay the UI indefinitely.
- Events from a stale turn do not update the current visible turn.

### Tests

- `scripts/test-turn-controller.mjs`
- `scripts/test-session-events.mjs`
- `scripts/test-agent-runner.mjs`
- `scripts/test-agent-tool-lease.mjs`
- `scripts/test-turn-auto-recovery.mjs`
- new targeted tests for wait notices and stale event metadata.

## Immediate Execution Plan

Start with Phase 1 because it directly affects user trust in the chat product.

### Step 1

Audit and tighten image send flow:

- user bubble commits before vision translation,
- vision progress notice is visible,
- vision failure is non-blocking,
- tests verify ordering.

Status: completed for the current architecture. Existing image-send tests verify
that user messages commit before slow vision enrichment. The visible
`visionPreparing`, `visionReady`, and `visionSkipped` notices remain the current
progress surface.

### Step 2

Audit and tighten queue/stop/interrupt behavior:

- current session only,
- queue chips always reflect main-process queue state,
- stop clears current queue only,
- interrupt-and-send bypasses normal queue intentionally.

Status: completed for the current architecture. Queue dispatch is now restricted to the `idle` phase. The
turn boundary remains responsible for finalizing the previous turn before
flushing one queued message.

### Step 3

Audit long-running tool leases:

- foreground shell blocks completion,
- detached shell does not block completion,
- long-running notice is emitted once and replaced cleanly.

Status: completed for the current architecture. Tool lease tests now verify
that explicit background commands and common long-running commands release the
turn, while foreground commands such as tests still wait for `tool_result`.

### Step 4

Add health diagnostics for activation/update deployment.

This directly addresses the recent activation failure where the service was
running an old Docker tag and did not have signing key support in the active
container.

Status: completed for the current architecture. The admin API exposes a health
diagnostic endpoint for database connectivity, license key presence, signing
self-test, update manifest reachability, and runtime release metadata. The admin
UI has a Health page, and the Baota deploy script now runs the admin health
check after container startup.

### Step 5

Question-answer stability pass:

- propagate `turnId` through live IPC events,
- show first-response and long-wait notices,
- hide raw resume/session errors behind a friendly refresh notice,
- cap tool result text before sending it to renderer.

Status: completed for the current stability scope.

Completed in this pass:

- live IPC events now carry `turnId` for chunks, status, tools, notices,
  permission prompts, user questions, done, and error boundaries,
- renderer live event handlers reject stale turn events before mutating the
  active assistant bubble,
- image preflight notices (`visionPreparing` / `visionReady` /
  `visionSkipped`) are tied to the same turn as the user message,
- slow first response and long wait states emit visible engine notices before
  the user is left waiting silently,
- raw resume/session failures are converted into a friendly "connection
  refreshed" message while preserving the local transcript,
- large tool results are truncated before reaching the renderer so a command
  cannot flood the chat UI.

Verified:

- `node scripts/test-agent-tool-lease.mjs`
- `node scripts/test-agent-runner.mjs`
- `node scripts/test-turn-controller.mjs`
- `node scripts/test-session-events.mjs`
- `node scripts/test-turn-auto-recovery.mjs`
- `node scripts/test-turn-message-queue.mjs`
- `node scripts/test-image-send-flow.mjs`
- `npm run test:unit`
- `npm --prefix web run build`
- `npm --prefix server run smoke`

Remaining refinement:

- Long-running shell classification is intentionally conservative. It covers
  common dev servers, file watchers, log followers, and explicit background
  commands. Unknown commands still stay foreground until `tool_result` so tests,
  builds, and migrations do not get hidden.

## Phase 7: Runtime Protocol Adapter

### Objective

Stop treating Claude CLI as a plain terminal text stream. Treat it as a runtime
protocol and normalize raw events before they reach turn state, IPC, or UI.

### Completed

- Added `src/main/claude-event-normalizer.js` as the single adapter for Claude
  CLI raw events.
- `AgentSession` now dispatches normalized action kinds instead of switching
  directly on raw `ev.type`.
- AskUserQuestion normalization lives in the adapter, so loose CLI payloads
  (`question`, `prompt`, `message`, string questions, or `questions[]`) become a
  stable internal question shape.
- Unknown runtime events become visible protocol warnings instead of silently
  disappearing. High-frequency known task telemetry remains silent.
- Tests now cover normalized control requests, permissions, text deltas,
  unknown runtime events, unknown system subtypes, and fallback questions.
- Runtime fixture replay is available under `fixtures/claude-runtime/` and runs
  in `npm run test:unit`.

### Contract

All new Claude CLI event handling must enter through `normalizeClaudeEvent()`.
Renderer, IPC, and turn orchestration must consume app-level actions/events, not
raw Claude CLI shapes.

### Verified

- `node scripts/test-agent-runner.mjs`
- `node scripts/test-claude-runtime-fixtures.mjs`
- `node scripts/test-agent-tool-lease.mjs`
- `npm run test:unit`
- `npm --prefix web run build`

## Phase 8: Runtime Diagnostics Loop

### Objective

Close the loop from client protocol anomaly to server visibility to future
fixture coverage without collecting private chat or file content.

### Completed

- Client-side protocol warnings and unknown runtime/control events are sanitized
  and reported through `reportRuntimeProtocolIssue()`.
- Reports include device/app/platform/Claude version, event type/subtype,
  normalized kind, turn/session state, and a sanitized trace summary.
- Service API accepts diagnostics at `POST /api/diagnostics/runtime-traces`.
- Server stores diagnostics in `runtime_diagnostics`.
- Admin API exposes diagnostics list and detail endpoints.
- Admin UI has `/admin/diagnostics` for filtering and inspecting sanitized
  traces.
- Duplicate client reports are debounced to avoid flooding the service.

### Privacy Boundary

Diagnostics intentionally keep protocol shape, event keys, tool names, and
hashes. They do not upload raw prompts, file contents, full tool inputs, or
workspace paths.

### Verified

- `node scripts/test-runtime-diagnostics.mjs`
- `node scripts/test-service-client.mjs`
- `npm run test:unit`
- `npm --prefix web run build`
- `DATABASE_URL=postgres://postgres:root@localhost:5432/lily_workbench ADMIN_TOKEN=integration-token ALLOW_UNSIGNED_LICENSES=true npm --prefix server run integration`
