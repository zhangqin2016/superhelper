# Character Worlds Phase 2: World Book Activation

Date: 2026-07-31
Status: In progress
Design source: `docs/superpowers/specs/2026-07-29-character-worlds-design.md`
  (§7.4 world book revision, §10.4 activation, §10.3.1 envelope order,
  §10.4.6 timed effects, §10.4.7 V3 decorators, §10.6 complexity envelope)
Builds on: Phase 1 (`docs/superpowers/plans/2026-07-30-character-worlds-phase-1.md`,
all complete through `cdfea08`)

## Scope

Phase 2A delivers world-book lore activation end to end: world-book entities
with immutable revisions, embedded `character_book` import, a deterministic
pure activation resolver over the admitted turn snapshot, compiler envelope
integration, timed-effect checkpoints, V3 decorator compilation, and the
capability-gate/acceptance updates.

Explicitly OUT of Phase 2A (later phases):

- Persona entities and persona-linked lore (§7.3; persona description lands in
  the envelope as part of that phase).
- Chat-linked and profile-global books (only character-embedded books).
- Semantic/vector activation (spec marks it optional; lexical deterministic
  activation stays the baseline).
- Regex activation keys: evaluated through the bounded linear-time path ONLY
  if a safe engine already exists in the repo; otherwise entries with
  `useRegex` activate nothing and are reported inert in the compatibility
  report (fail closed, never main-thread arbitrary regex).
- Group/story modes (§12), character memory (§11), library management UI.

## Invariants (carried from Phase 1, HANDOFF.md §6)

1. Imported behavior stays lower authority: world entries render only inside
   the Character Worlds envelope, never as Lily system policy, user messages,
   or fabricated history.
2. Activation is a pure resolver over the ADMITTED immutable snapshot — never
   the current binding, never live library state.
3. Everything is deterministic: same snapshot + revision + checkpoint → same
   insertion plan and fingerprint. Probability uses the existing SHA-256
   counter PRNG construction (`character-worlds/macro-prng.js` pattern), never
   `Math.random`.
4. All work is bounded (scan depth, entry count, corpus chars, recursion
   steps, token budget, elapsed time) with complexity counters in diagnostics
   (§10.6); no turn does work proportional to the whole library or whole
   conversation.
5. Unknown fields/decorators/positions are preserved inert and reported;
   unsupported positions map to a documented lower-authority bucket with
   `safe_behavior`, never claimed as lossless.
6. Timed-effect checkpoints persist transactionally only after successful
   turn finalization; retry/restart/variant/rewind restore or invalidate them
   at the retained turn boundary (§10.4.6).
7. Native turns remain byte-equivalent; every failure degrades to native Lily.
8. Do not weaken `CAPABILITY-GATE.md`; new behavior lands behind the existing
   `character-worlds-isolation` vector with added guards.

## Task WB-1: World-Book Persistence

**Files:**
- Modify: `src/main/store/schema.js`
- Modify: `src/main/character-worlds/repository.js`
- Create: `src/main/character-worlds/world-book-model.js`
- Create: `scripts/test-character-world-book-store.mjs`

- [x] **Step 1: Write failing store tests**
  Mirror `test-character-worlds-store.mjs`: create world-book entity +
  immutable revision with normalized entries (activation/insertion/recursion
  blocks), revision hash includes canonical data + provenance, duplicate
  revision reuse, unknown fields preserved inert, owner scoping, archive
  semantics, immutable revision rejection on mutation attempts.
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Add additive schema**
  `world_book_entities` / `world_book_revisions` /
  `world_book_revision_blobs` mirroring the character tables (no changes to
  existing character tables or rows; migration additive only).
- [x] **Step 4: Implement the normalized entry model**
  `world-book-model.js`: bounded validation/normalization of the §7.4 entry
  shape (ids, keys, selective logic enum, probability 0-100, insertion
  position enum + order, recursion flags, timed fields, characterFilter,
  preservedDecorators/preservedExtensions inert). Reject Proxies/accessors;
  bound all strings/arrays/counts with versioned constants.
- [x] **Step 5: Repository methods**
  `createWorldBook`, `createWorldBookRevision`, `getWorldBook`,
  `getWorldBookRevision`, `listWorldBooks`, `archiveWorldBook` — same
  transaction/CAS/dedup patterns as characters.
- [x] **Step 6: Run store + regression tests**
- [x] **Step 7: Commit** — `feat: add world book persistence`

## Task WB-2: Embedded character_book Import

**Files:**
- Modify: `src/main/character-worlds/card-parser.js`
- Modify: `src/main/character-worlds/import-repository.js`
- Modify: `src/main/character-worlds/service.js`
- Create: `scripts/test-character-world-book-import.mjs`

- [x] **Step 1: Write failing import tests**
  V2/V3 cards with embedded `character_book`: imported as a world-book
  revision linked via `characterBookRevisionId`; entry count/fields bounded;
  unsupported entry fields inert + compatibility report; oversized/hostile
  books fail closed; preview shows book summary (entry count, supported/inert
  counts); duplicate book revision deduped across imports.
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Parse character_book in the card pipeline**
  Reuse the bounded parser; normalize through `world-book-model.js`; report
  inert fields via the existing compatibility-report path.
- [x] **Step 4: Persist through the import flow**
  Commit creates the book revision in the same transaction as the character
  revision; `characterBookRevisionId` pinned on the character revision;
  rollback removes both (existing blob/refcount discipline).
- [x] **Step 5: Run import + hardening regressions**
- [x] **Step 6: Commit** — `feat: import embedded character books`

## Task WB-3: Deterministic Activation Resolver

**Files:**
- Create: `src/main/character-worlds/world-book-activation.js`
- Create: `src/main/character-worlds/world-book-corpus.js`
- Create: `scripts/test-character-world-book-activation.mjs`

- [x] **Step 1: Write failing resolver tests**
  Golden fixtures: constant entries; primary-key match with selective logic
  (and_any/and_all/not_any/not_all); case sensitivity and whole-word (CJK
  exemption); probability 0/100 and deterministic mid-range (same seed → same
  outcome across processes); inclusion-group weighted choice without modulo
  bias; bounded recursion with preventFurtherRecursion /
  excludeFromRecursion / delayUntilRecursion; sticky carry-over from
  checkpoint; cooldown/delay against canonical message sequence numbers;
  budget truncation records omissions; adversarial 10k-entry book stays within
  complexity counters.
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Build the scan corpus**
  `world-book-corpus.js`: canonical messages from the admitted session
  (bounded scan depth), stable participant separators + resolved display
  names, Unicode NFC + version-pinned case folding, matching-source opt-ins
  (description/personality/scenario/creator notes) that never get inserted.
- [x] **Step 4: Implement the pure resolver**
  `resolveWorldBookActivation({ bookRevision, corpus, checkpoint, seed
  identity, budget, compatibilityProfile })` → `{ activated: [...], omitted:
  [...], nextCheckpoint, trace, complexity }`. Multi-pattern plain-key index
  (no entries×keys×corpus loops), deterministic probability (SHA-256 counter
  keyed by owner/session/turn/revision/entry/phase), inclusion-group conflict
  graph resolution, bounded recursion fixed point, selective filters,
  generation/character filters, complexity counters.
- [x] **Step 5: Run resolver tests**
- [x] **Step 6: Commit** — `feat: resolve world book activation deterministically`

## Task WB-4: Compiler Envelope Integration + Timed Checkpoints

**Files:**
- Modify: `src/main/character-worlds/context-compiler.js`
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/store/turn-input-store.js` (or a new small store module)
- Create: `scripts/test-character-world-book-compile.mjs`

- [ ] **Step 1: Write failing compile tests**
  Activated entries land in the correct envelope buckets per §10.3.1 order
  (before/after character, before/after examples, author note top/bottom;
  at_depth/outlet → documented lower-authority bucket + `safe_behavior`
  report); `activatedWorldEntries` (revisionId, entryId, reason, contentHash)
  in the compiled contract; budget share respected (world entries below
  identity/persona in §10.3 priority); deterministic fingerprint; native when
  the book is missing/corrupt.
- [ ] **Step 2: Write failing checkpoint tests**
  Checkpoint written only after successful turn finalization; sticky effects
  activate on the NEXT turn; failed/interrupted turns write none; retry and
  restart restore/invalidate at the retained turn boundary; accepted steer
  shares the turn's single message-sequence increment.
- [ ] **Step 3: Run tests, verify they fail**
- [ ] **Step 4: Integrate the resolver into the compiler**
  New envelope blocks with type/source revision/content hash/token count/
  compatibility level; `activatedWorldEntries` + `omitted` in the compiled
  output; fail open to character-only compile on any resolver error.
- [ ] **Step 5: Persist timed checkpoints**
  Durable checkpoint store keyed by (ownerScope, sessionId,
  worldBookRevisionId); transactional write in the terminal finalizer's
  successful path only; snapshot carries the checkpoint fingerprint so retry/
  recovery replays the same activation.
- [ ] **Step 6: Run compile + orchestrator + binding-isolation regressions**
- [ ] **Step 7: Commit** — `feat: compile activated world entries per turn`

## Task WB-5: V3 Decorator Compilation

**Files:**
- Create: `src/main/character-worlds/world-book-decorators.js`
- Modify: `src/main/character-worlds/world-book-model.js`
- Create: `scripts/test-character-world-book-decorators.mjs`

- [ ] **Step 1: Write failing decorator tests**
  §10.4.7: typed AST for recognized decorators (activation-count,
  greeting-index, scan-depth, role, position, depth, reverse-depth, stateful
  match); first-value rule for duplicate single-value decorators; `@@@`
  fallback chains depth ≥ 5; explicit position overrides depth; unknown/
  invalid decorators inert + reported; decorator text never treated as
  macro/script/instruction; decorator decisions included in revision index
  hash and golden fixtures.
- [ ] **Step 2: Run tests, verify they fail**
- [ ] **Step 3: Implement the decorator compiler**
- [ ] **Step 4: Wire into revision-index build**
- [ ] **Step 5: Run decorator + import regressions**
- [ ] **Step 6: Commit** — `feat: compile v3 world book decorators`

## Task WB-6: IPC Surface + Capability Gate + Acceptance

**Files:**
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/preload.js` (read-only additions only)
- Modify: `src/shared/capability-gates.json`
- Modify: `CAPABILITY-GATE.md`
- Modify: `docs/character-worlds-phase-1-acceptance.md`
- Create: `scripts/test-character-world-book-ipc.mjs`

- [ ] **Step 1: Write failing tests**
  Read-only book inspection (list/get with entry summaries and compatibility
  reports) through the trusted bridge; no renderer mutation paths for books in
  Phase 2A; capability gate covers world-book failure modes (missing/corrupt
  book, resolver error, over budget) → byte-equal native.
- [ ] **Step 2: Run tests, verify they fail**
- [ ] **Step 3: Add read-only IPC + preload methods**
- [ ] **Step 4: Extend gate + stress + runbook**
  Add world-book guards to `character-worlds-isolation`; stress ops include
  book import/activation; acceptance runbook gains world-book manual checks
  (embedded book import, activation visible in trace, kill switch covers
  books).
- [ ] **Step 5: Run the full matrix**
- [ ] **Step 6: Commit** — `feat: expose world book inspection and gate`

## Phase 2A Exit Criteria

- World-book data is local, owner-scoped, immutable-revision pinned, and
  snapshotted through the same admission binding as the character.
- Embedded V2/V3 character books import bounded, preserve unknown data
  inertly, and never execute anything.
- Activation is deterministic, bounded, traceable, and purely a function of
  the admitted snapshot + durable checkpoint.
- Activated entries render only inside the lower-authority envelope in
  §10.3.1 order; Lily guidance, user history, and tools are unaffected.
- Timed effects survive restart exactly at committed turn boundaries; failed
  turns never advance them.
- Native turns stay byte-equivalent; every world-book failure degrades to
  native Lily with diagnostics.
- Capability gate, stress, focused regressions, and runbook updates are
  complete.
