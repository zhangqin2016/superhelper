# Character Worlds Runtime Boundary Design

**Date:** 2026-08-01
**Status:** Approved for implementation

## Goal

Move Character Worlds orchestration behind one local runtime boundary so role,
persona, world-book, scene, memory, group-speaker, checkpoint, and variant
behavior share one immutable admission snapshot and cannot bleed across owners
or conversations.

## Invariants

- Native Lily turns do not create Character Worlds rows, call a second model, or
  change the protected Lily task contract.
- Every enabled turn is admitted once with `{ownerScope, sessionId, turnId,
  binding, scene, policy, checkpoint}`. Retries and steers reuse that snapshot.
- Narrative state is lower authority than Lily task context. It cannot change
  tools, permissions, evidence, files, payments, or task classification.
- Finalization is the only state-advancing boundary. Failed, cancelled,
  interrupted, uncertain, and rewound turns do not advance memory or timed
  checkpoints.
- Missing, corrupt, disabled, or throwing Character Worlds dependencies fail
  open to native Lily and emit bounded diagnostics.

## Runtime API

`CharacterWorldsRuntime` owns the repository and exposes only these orchestration
operations:

- `admitTurn(input)` returns a frozen admission snapshot or native mode.
- `compileTurn(snapshot, canonicalHistory)` returns a bounded lower-authority
  envelope and pending checkpoint.
- `planSpeakers(snapshot, canonicalMessage)` returns validated expression-only
  speaker decisions.
- `finalizeTurn(snapshot, outcome)` commits memory, checkpoint, and variant
  state in one owner/session-scoped transaction only for successful outcomes.
- `rewindTo(sessionId, retainedTurnId)` invalidates descendants by source
  lineage and restores the retained checkpoint.
- `exportScene` and `importScene` delegate package preview and id remapping.

IPC, the Turn Orchestrator, compiler, and terminal finalizer may call the
runtime facade but must not write Character Worlds tables directly.

## Persistence

Existing migrations remain additive. New tables use explicit owner scope and
immutable event rows for scene memory, speaker decisions, and response variants.
Existing world-book checkpoints remain compatible and are wrapped by the
runtime checkpoint adapter. Legacy rows without scene data resolve to native or
empty scene state.

## Migration order

1. Add and test the contract and runtime facade while preserving current
   helpers.
2. Route admission and compile through the facade.
3. Move memory and checkpoint writes behind `finalizeTurn` and add rewind
   lineage handling.
4. Move group planning and variants behind the same snapshot.
5. Route IPC and portability through the facade; delete direct orchestration
   calls only after parity tests pass.
6. Update capability gates, acceptance evidence, gap trace, and handoff.

## Release criteria

The refactor is complete only when the Character Worlds focused suite, the
capability gate, and the full unit suite pass in a real Electron/runtime
environment; native and role task parity remains byte-stable; concurrent
owner/session stress has no cross-scope state; and all manual/model acceptance
rows have evidence.
