# Character Worlds Runtime Boundary Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Replace scattered Character Worlds orchestration with one snapshot-driven runtime while preserving native Lily behavior and closing the documented Phase 3 gaps.

**Architecture:** `CharacterWorldsRuntime` will own admission, compilation, speaker planning, finalization, rewind, and portability orchestration. Existing repositories and pure resolvers remain reusable implementation details; external callers use the runtime facade and immutable snapshots. All persistence changes are additive and owner-scoped.

**Tech Stack:** Electron main process, CommonJS modules, node:sqlite-backed MessageStore, existing world-book resolver/compiler, Node scripts discovered by `scripts/run-all-tests.mjs`.

## Implementation Status (2026-08-01)

Tasks 1-6 are implemented and covered by the focused Character Worlds suite:
runtime admission/compile/finalize, owner-scoped scene memory and rewind,
deterministic group planning and safe variants, IPC, migration, and workspace
portability. Task 7 is partially complete: stale schema/channel assertions and
the agent-draft production regression are fixed. The full unit suite passed in
the real runtime environment: `555/555`. Manual/model acceptance remains
environment-dependent and is not marked complete.

---

### Task 1: Establish the runtime contract

**Files:**
- Create: `src/main/character-worlds/runtime.js`
- Create: `src/main/character-worlds/runtime-contract.js`
- Test: `scripts/test-character-worlds-runtime.mjs`

- [ ] Write tests for native admission, owner/session isolation, immutable snapshot reuse, disabled-policy fallback, and bounded diagnostics.
- [ ] Run `node scripts/test-character-worlds-runtime.mjs` and confirm it fails because the runtime modules do not exist.
- [ ] Implement `normalizeAdmissionSnapshot`, `nativeSnapshot`, and `CharacterWorldsRuntime.admitTurn` with frozen plain data, exact owner/session/turn validation, and fail-open native fallback.
- [ ] Implement runtime delegation for current `turn-world-book` compilation without changing output bytes.
- [ ] Run the focused test plus `test-character-binding-isolation.mjs`, `test-character-worlds-capability-gate.mjs`, and `test-character-agent-task-parity.mjs`.

### Task 2: Route the current turn path through the facade

**Files:**
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/turn-terminal-finalizer.js`
- Modify: `src/main/character-worlds/turn-world-book.js`
- Test: `scripts/test-character-worlds-runtime.mjs`

- [ ] Add failing assertions that enabled turns call one runtime admission and retries/steers reuse the exact snapshot object identity/fingerprint.
- [ ] Replace direct compile/finalizer orchestration with runtime calls while retaining native mode byte equivalence.
- [ ] Preserve existing world-book checkpoint persistence as the runtime adapter's first implementation.
- [ ] Run the focused turn and capability tests and inspect native/role parity fingerprints.

### Task 3: Move memory into an owner-scoped event service

**Files:**
- Create: `src/main/character-worlds/scene-memory-service.js`
- Modify: `src/main/character-worlds/scene-memory.js`
- Modify: `src/main/character-worlds/runtime.js`
- Modify: `src/main/store/schema.js`
- Test: `scripts/test-character-scene-memory.mjs`

- [ ] Add failing tests for owner isolation, source-turn validation, exact duplicate deduplication, supersession, bounded retrieval, and rewind descendant invalidation.
- [ ] Add additive schema migration for owner-scoped memory events and checkpoints.
- [ ] Implement append-only memory events with normalized text/source hash, source existence checks, and deterministic lexical/recency selection.
- [ ] Make finalization write memory only after successful completion and never write placeholder facts when canonical content is absent.
- [ ] Route context injection and renderer memory reads through the service.
- [ ] Run scene-memory, compaction, binding-isolation, restart, and concurrency tests.

### Task 4: Implement deterministic group scene planning

**Files:**
- Create: `src/main/character-worlds/speaker-planner.js`
- Modify: `src/main/character-worlds/group-modes.js`
- Modify: `src/main/character-worlds/runtime.js`
- Test: `scripts/test-character-group-modes.mjs`
- Test: `scripts/test-character-model-assist-hooks.mjs`

- [ ] Replace null-fixture tests with real immutable revision IDs and add tests for Unicode whole-word names, self-response policy, muted/missing/foreign participants, talkativeness, seeded fallback, semantic ID validation, and retry determinism.
- [ ] Implement participant validation against the repository and owner scope before planning.
- [ ] Implement `manual`, `natural`, `list_order`, `pooled`, and optional `semantic` planning behind one API; semantic selection receives a bounded roster and never creates a coordinator turn.
- [ ] Archive planner inputs and decisions in the admission snapshot for retry/restart replay.
- [ ] Run group planning, compile, portability, task parity, and concurrency tests.

### Task 5: Make variants side-effect safe

**Files:**
- Modify: `src/main/character-worlds/group-modes.js`
- Modify: `src/main/character-worlds/runtime.js`
- Modify: `src/main/store/schema.js`
- Test: `scripts/test-character-group-modes.mjs`

- [ ] Add failing tests requiring exact session/turn keys, binding snapshot fingerprints, text-only/no-side-effect eligibility, and no duplicate tool execution.
- [ ] Add an append-only variant ledger with snapshot fingerprint and side-effect classification.
- [ ] Reject regeneration for uncertain or side-effecting turns and allow text-only projection from archived evidence.
- [ ] Run variant and turn-terminal regression tests.

### Task 6: Route IPC and portability through the runtime

**Files:**
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/main/character-worlds/workspace-portability.js`
- Modify: `src/main/character-worlds/service.js`
- Test: `scripts/test-character-worlds-ipc.mjs`
- Test: `scripts/test-character-workspace-portability.mjs`

- [ ] Add failing tests that IPC scene/memory reads and writes use the owner-scoped runtime facade, and hostile imported scene/memory sections degrade to native with diagnostics.
- [ ] Route scene CRUD, memory projection, and portability through the facade.
- [ ] Preserve existing IPC allowlists and add explicit validation for new runtime payloads.
- [ ] Run IPC, workspace, import-hardening, and architecture-boundary tests.

### Task 7: Repair release gates and acceptance records

**Files:**
- Modify: `scripts/test-character-agent-draft.mjs`
- Modify: all tests with stale v12 expectations identified by the focused run
- Modify: `docs/character-worlds-gap-trace.md`
- Modify: `docs/character-worlds-phase-1-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-31-character-worlds-phase-2c.md`
- Modify: `docs/superpowers/plans/2026-08-01-character-worlds-phase-3.md`

- [ ] Add a regression test proving the production default owner resolver is available and policy-enabled draft tools are visible.
- [ ] Update stale schema/channel assertions to current contracts without weakening behavior checks.
- [ ] Run focused gates, then the full unit suite in the real runtime environment.
- [ ] Record only verified automated results; leave real-device/model rows open until evidence exists.
- [ ] Update the handoff only after the current HEAD, plan checkboxes, and gap trace agree.

### Task 8: Final verification

**Files:**
- Test: all discovered `scripts/test-*.mjs` and `scripts/test-*.cjs`

- [ ] Run `npm run test:capability-gate`.
- [ ] Run `npm run test:unit`.
- [ ] Run the Character Worlds concurrency, fuzz, performance, parity, workspace, and model-eval cases.
- [ ] Inspect `git diff`, `git status`, and the final requirement matrix.
- [ ] Do not claim completion while any deterministic test, release gate, or required manual evidence remains open.
