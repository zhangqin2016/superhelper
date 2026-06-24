# Lily Workbench vs Claude CLI / OpenCode Desktop Gap Audit

Date: 2026-06-24

Scope:
- Lily Workbench Electron main/renderer runtime flow.
- OpenCode official desktop/server/core architecture available under `opencode/`.
- Claude CLI compatibility surface as currently wrapped by Lily.

This audit focuses on architecture ideas that make the official clients feel stable, observable, and hard to corrupt under multi-session / long-running / abnormal-stop scenarios. It does not argue for copying the official UI wholesale. Lily should keep its product layer: skills, runtime packs, document pipeline, Qwen vision, app store, and session-level tool broker.

## Executive Summary

Lily has already absorbed several correct official ideas:
- One shared OpenCode server instead of one CLI process per chat.
- Per-workspace SDK clients.
- Global event stream demux and event coalescing.
- A runtime reducer that maps OpenCode events into Lily UI events.
- Multi-session concurrency tests and startup-readiness handling.

The remaining gap is not a small bug. The official architecture is built around three hard source-of-truth layers that Lily still partly reconstructs in host code:

1. Durable prompt admission and run coordination.
2. Durable event log plus projector.
3. Clean separation between user prompt, system/context instructions, and UI metadata.

These are the areas most likely behind the recurring symptoms users reported: first request occasionally failing, half answers, abnormal-stop history rendering, “assistant did not return final result”, old hidden guidance appearing as user content, and model behavior feeling less smart after switching engines.

## P0 Gaps

### 1. Durable Prompt Admission / Run Coordinator

Official OpenCode:
- `SessionInput.admit` persists an admitted prompt with a monotonic admitted sequence.
- `execution.wake(sessionID, admittedSeq)` wakes the runner.
- `RunCoordinator` guarantees one active drain per session key while allowing different sessions to run concurrently.
- Interrupts use boundaries, so stale queued wakes do not kill newer turns.

Lily today:
- `TurnOrchestrator` owns an in-memory turn queue and commits local user messages before engine admission is proven.
- `OpencodeAgentSession` compensates with startup readiness, dispatch-failure timers, health probes, transient failure timers, and SSE proof windows.
- This is better than naive spawning, but still means “user submitted” and “engine durably admitted” are not the same fact.

Risk:
- A first request can fail during startup while the local UI already has a user turn.
- A later retry can succeed, leaving confusing history.
- Multi-session failures become hard to reason about because host queue state and engine state are separate.

Recommendation:
- Add a Lily-side `TurnInput` table modeled after OpenCode `SessionInput`.
- Store `session_id`, `turn_id`, `admitted_seq`, `promoted_seq`, `delivery`, `status`, `created_at`, and the exact user-visible prompt.
- Implement a `TurnRunCoordinator` modeled after OpenCode `RunCoordinator`: one drain per Lily session, coalesced wakes, explicit interrupt boundary.
- Only mark a turn “running” after either OpenCode prompt admission succeeds or a durable Lily admission is replayable.

Acceptance tests:
- First prompt immediately after app startup never becomes a permanent failed turn if the OpenCode server becomes healthy within the retry window.
- Two sessions can run concurrently without either ending the other.
- Interrupting one session cannot truncate another session.
- Restarting the app replays admitted-but-not-promoted prompts deterministically.

### 2. Durable Event Log + Projector

Official OpenCode:
- Events are typed, sequenced, and persisted.
- Projectors run transactionally and rebuild `session`, `message`, `part`, `todo`, and relation tables.
- Live UI and history are projections of the same event source.

Lily today:
- Live UI is assembled from runtime batches.
- History is loaded from official OpenCode messages, then merged with Lily metadata and legacy `messages.db`.
- Abnormal stops require adapter/backfill/reconciliation logic.

Risk:
- Live state and historical state can disagree.
- “思考中”, tool cards, partial answers, and final text can render differently after reload.
- Fixes keep landing in individual render paths instead of at the source of truth.

Recommendation:
- Add `runtime_events` and `turn_projection` storage for Lily-normalized events.
- Persist every normalized OpenCode event with a monotonic local sequence and original OpenCode event id/type when available.
- Build renderer conversation state only from a projector, not from ad hoc merge logic.
- Keep official OpenCode storage as the engine source; use Lily event log as product projection and recovery layer.

Acceptance tests:
- Kill app mid-run, restart, and historical rendering matches pre-kill live rendering.
- Partial answer, tool call, permission request, question prompt, and interrupted turn all replay identically.
- Unknown OpenCode event types are persisted and visible in diagnostics instead of being silently reduced to generic text.

### 3. Prompt / Context / Metadata Separation

Official OpenCode:
- User messages are user messages.
- Instructions, agents, skills, config, permissions, context, and compaction are separate engine concerns.

Lily today:
- Lily guidance is injected into prompts.
- Conversation source then filters/hides injected prompts and remaps local user display messages by timestamp.
- This was pragmatic, but it creates brittle history and can make the model feel “dumber” because every turn carries extra policy/context noise.

Risk:
- Hidden guidance can leak into history.
- Follow-up questions can bind to the wrong previous user intent.
- Engine context becomes inflated and less semantically clean.

Recommendation:
- Move stable Lily rules into session configuration / agent instructions / generated AGENTS context, not per-turn hidden user prompt text.
- Move per-turn task contracts into metadata or official prompt fields when supported, never into the canonical user message.
- Store the exact user-visible prompt separately from any engine envelope.

Acceptance tests:
- Official message history never contains Lily hidden guidance as a user-authored message.
- “?” follow-up resolves to the previous user-visible task, not injected context or a stale tool summary.
- Long sessions show lower prompt noise and more stable task continuity.

## P1 Gaps

### 4. Sidecar Process Parity

Official OpenCode Desktop:
- Starts the server in an Electron `utilityProcess`.
- Uses an explicit ready handshake plus `/global/health`.
- Sets loopback `NO_PROXY`, loads system certificates, applies proxy env, and uses server auth.
- Handles process-gone and start/stop timeouts explicitly.

Lily today:
- Spawns `opencode serve` and parses stdout for readiness.
- Has health checks and event readiness, but not full official sidecar parity.

Recommendation:
- Prefer embedding the official server sidecar if packaging permits.
- If not, copy the sidecar contract: explicit auth, no-proxy loopback, system cert/proxy setup, process-gone classification, and health-loop readiness instead of stdout-only readiness.

### 5. Official Event Store Passthrough

Official app:
- Maintains a directory-scoped SDK cache and applies event reducer updates for `session.status`, `message.updated`, `message.part.updated`, `todo.updated`, LSP, MCP, and provider state.

Lily today:
- Converts events into Lily runtime events. Useful, but some official semantics can be lost.

Recommendation:
- Add a parallel “official event projection” store for diagnostics and exact parity.
- Lily UI should layer product-specific presentation on top of official event state rather than replace the semantics.

### 6. Context Epoch and Compaction Alignment

Official OpenCode:
- Uses context epochs and runner context baselines.
- Compaction is a first-class session operation.

Lily today:
- Has memory/bootstrap/skills/context injection, but much of it is host-managed and prompt-shaped.

Recommendation:
- Align skill/workspace context injection with context epochs.
- Only refresh expensive global guidance when the epoch changes.
- Treat compaction as an explicit official session operation exposed through the SDK wrapper.

## P2 Gaps

### 7. Full SDK Surface

Official session API includes operations beyond Lily’s current wrapper, including shell, skill, compact, wait, resume, and richer interrupt semantics.

Recommendation:
- Extend `opencode-sdk-session.js` to cover the official session surface that exists in the installed SDK.
- Add contract tests that verify wrapper behavior against local OpenCode server help/API shape.

### 8. Broker Decisions as Session State

Lily’s session-level tool broker is the right product direction. It is stronger than plain official OpenCode for non-developer users because it can hide unavailable tools and expose only session-authorized capabilities.

Gap:
- Broker decisions should be durable, auditable session events, not just config assembled at runner startup.

Recommendation:
- Emit durable broker events: tool allowed, tool denied, skill enabled, skill disabled, runtime pack missing, credential required, login session captured.
- Project them into the session diagnostics view.

## What Lily Should Not Copy Blindly

Do not replace Lily’s product layer with official OpenCode UI behavior:
- Lily’s document pipeline, runtime packs, skill registry, Qwen vision flow, application store, and broker are product advantages.
- The official desktop UI is a strong baseline for stability and observability, but Lily’s target users need more guided capability surfacing.

The correct direction is:

```text
Official OpenCode server/session/event model
        ↓
Lily durable projection and broker
        ↓
Lily user-facing workflow UI
```

Not:

```text
Lily host queue + hidden prompt envelope + post-hoc history reconciliation
```

## Implementation Roadmap

### Phase 1: Source-of-Truth Hardening

- Add `TurnInput` durable admission table.
- Add `TurnRunCoordinator`.
- Add tests copied in spirit from OpenCode `session-run-coordinator.test.ts`.
- Stop marking turns as permanently failed before startup retry / admission replay is exhausted.

### Phase 2: Replayable Runtime State

- Add normalized `runtime_events`.
- Add projector for `turn_projection`.
- Make live rendering and history rendering consume the same projection.
- Add abnormal-stop replay tests.

### Phase 3: Prompt Hygiene

- Remove hidden guidance from canonical user messages.
- Move stable Lily rules into config/context.
- Keep exact user prompt as immutable display text.
- Add follow-up grounding tests for “?”, “继续”, “不是这个，是上一个”.

### Phase 4: Sidecar and Diagnostics

- Bring sidecar startup closer to official desktop.
- Add proxy/cert/no-proxy/auth parity.
- Add a compact per-session engine diagnostics surface using official event/status state.

## Final Judgment

Lily is not far off because the shared OpenCode server and SDK event flow are already in place. The missing top-tier idea is discipline around source of truth:

- Prompts must be durably admitted.
- Runs must be coordinated by sequence, not timers.
- Events must be replayable.
- UI state and history must come from the same projection.
- User prompt must stay clean.

If those are implemented, Lily can keep its stronger product layer without inheriting the instability that comes from host-side compensation.
