# Character Worlds Phase 3: Scene Memory + Group/Story Modes

Date: 2026-08-01
Status: Planned
Design source: `docs/superpowers/specs/2026-07-29-character-worlds-design.md`
  (§11 Memory Model, §12 Group And Story Modes, §12.1 response variants,
  §14.5 optional semantic indexing)
Builds on: Phase 1/2A/2B/2C (all committed through `71deca6`).

## Scope

Phase 3 delivers the design's remaining narrative stack with the SAME
discipline as Phase 2C: local-first, fail-open, and never an extra model
request on the normal turn path.

1. **P3-1 Scene memory (§11)** — per-(conversation, character-revision)
   episodic memory: durable provenance-bearing items, extraction only after a
   successful finalized turn, bounded injection into the lower-authority
   character context, opt-in semantic retrieval reusing `memory-vector-index`.
2. **P3-2 Group/story modes (§12)** — immutable participant scene with
   deterministic speaker planning (manual/natural/list_order/pooled, semantic
   opt-in), swap/join prompt modes with bounded participant summaries, and
   side-effect-safe response variants (§12.1).
3. **P3-3 Portability (§14.4 extension)** — workspace packs carry scene +
   memory sections with the same previewed opt-in and id remap as P2C-2.

## Explicitly OUT (per design / kept minimal)

- Model-assisted durable episodic EXTRACTION stays opt-in and off by default
  (design: default memory uses bounded recent canonical history, no second
  model request; §11 line 1162-1164).
- Semantic index generations are delegated to the existing
  `memory-vector-index` (now time-bounded) and require explicit enablement
  (§14.5); the character memory default is deterministic lexical/recency
  selection.
- Join prompt mode is reported as risky and cannot be enabled by a card; only
  the user scene control may select it.

## P3-1 Scene memory

### Step 1: write failing tests (test-character-scene-memory.mjs)
- durable items keyed by (conversation id, character revision id);
- `character_belief` may contradict reality and NEVER becomes a Lily task fact;
- updates append a superseding item (supersedesId), never rewrite history;
- extraction runs ONLY after a successful finalized turn — failed/cancelled/
  rewound turns do not advance memory;
- injection is bounded, lower-authority, after the protected Lily prefix;
- rewind restores the memory checkpoint of the retained turn boundary;
- exact duplicate extraction dedups (same text+sourceTurnIds).

### Step 2: run, verify fail

### Step 3: implement (src/main/character-worlds/scene-memory.js)
- `character_memory` table (session_id, character_revision_id, kind, text,
  source_turn_ids JSON, confidence, supersedes_id, created_at);
- `CharacterSceneMemory` service over the MessageStore:
  - `appendTurnMemory({ sessionId, ownerScope, characterRevisionId, turnId,
    finalized, items })` — only when `finalized === true`;
  - `listMemory({ sessionId, characterRevisionId, limit, budget })` — bounded,
    recency-first, supersedes-aware (superseding hides superseded);
  - `checkpointFor({ sessionId, turnId })` — rewind anchor;
- context-compiler integration: a bounded scene-memory block in the
  lower-authority character suffix (deterministic text, no extra model call);
- workspace-portability: memory section export/import (P3-3).

### Step 4: run tests + regressions

### Step 5: commit — feat: add character scene memory

## P3-2 Group/story modes

### Step 1: write failing tests (test-character-group-scene.mjs)
- scene persisted with immutable participant revision refs + mutable state;
- speaker planning: manual / natural (Unicode whole-word mentions, self-mention
  suppression, deterministic talkativeness, versioned PRNG fallback) /
  list_order / pooled (reset after all spoken or new user message);
- semantic opt-in: bounded roster passed to the primary Agent, returned IDs
  validated (unknown/duplicate removed), malformed selection falls back to
  explicit active speaker then deterministic natural, no extra coordinator
  call;
- promptMode swap compiles ONLY the active speaker's card + bounded shared
  scene/participant summaries; join combines declared safe fields in stable
  list order with per-member boundaries, reported risky;
- selection inputs + tie-breakers archived → retry/restart choose same fallback;
- speaker selection affects expression, never tool authority;
- response variants keyed by (session, turn) carry the same admitted binding
  snapshot and never duplicate payments/file edits.

### Step 2: run, verify fail

### Step 3: implement (src/main/character-worlds/group-scene.js)
- `character_scene` table (scene state per §12 schema) + CRUD;
- `planSpeakers(scene, latestCanonicalMessage, roster, deps)` — deterministic
  planner per strategy with seeded PRNG and archived inputs;
- `compileSceneContext(scene, repository, promptMode)` — swap/join with bounded
  participant summaries;
- `recordResponseVariant({ sessionId, turnId, bindingSnapshot, variant })` —
  side-effect-free variants ledger.

### Step 4: run tests + regressions

### Step 5: commit — feat: add character group scene modes

## P3-3 Portability extension

### Step 1: tests (extend test-character-workspace-portability.mjs)
- scene + memory sections packed only on explicit opt-in with preview;
- ids remapped on import; references to characters/books remapped;
- hostile sections degrade to native + diagnostic.

### Step 2-3: implement + verify

### Step 4: commit — feat: ship scene and memory in workspace packs

## Phase 3 Exit Criteria

- Scene memory is durable, provenance-bearing, bounded, never a Lily task
  fact, and injects only after the protected prefix; failed turns never
  advance it.
- Group scenes compile deterministically, selection affects expression only,
  retry/restart reproduce the same fallback, variants are side-effect-safe.
- Native turns stay byte-equivalent; every new failure mode degrades per §16.
- Capability gate, fuzz, stress, and runbook cover the new paths.
