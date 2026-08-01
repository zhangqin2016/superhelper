# Character Worlds Phase 2B: Native Authoring Foundation

Date: 2026-07-31
Status: In progress
Design source: `docs/superpowers/specs/2026-07-29-character-worlds-design.md`
  (§7.3 persona, §8 switching semantics, §10.3/§10.3.1 persona envelope slot,
  §13.2 character library, §18 Phase 2 "Native authoring")
Builds on: Phase 1 (`2026-07-30-character-worlds-phase-1.md`) and
Phase 2A (`2026-07-31-character-worlds-phase-2.md`), all complete.

## Scope

Phase 2B delivers the authoring half of the spec's Phase 2 ("Native
authoring"): Persona entities with envelope integration, validated
creation/editing domain APIs for characters/personas/world-books, revision
history with restore-as-new-revision, the library management UI, and
character-switching timeline events.

Explicitly OUT of Phase 2B:

- Natural-language draft creation by the agent (§13.2's "ask Lily to create" —
  the validated domain APIs built here are its prerequisite; agent wiring is
  Phase 2C together with workspace-package portability §14.4).
- Scene state, episodic memory, group/story modes, response variants,
  semantic retrieval, bounded regex activation (Phase 3 "Depth").
- Persona-linked lore books and group greetings.
- `greetingIndex` plumbing for `@@is_greeting` (remains documented inert).

## Invariants (carried forward)

1. Persona is narrative context only — no account/authorization fields, and it
   can never become an authenticated user (§7.3, §19.2).
2. All authoring mutations go through the same validated domain API the
   renderer and (later) the agent use; renderer never supplies owner scope.
3. Editing creates a NEW immutable revision; existing conversations stay
   pinned to their admitted snapshot and only show "update available" —
   applying it is an explicit binding change (§8).
4. Selecting a character never injects its first greeting into history (§8).
5. Switching is serialized with message acceptance per exact conversation,
   writes an immutable binding version + change event, and applies only to
   messages accepted after it (§8 + Phase 1 admission discipline).
6. Native turns stay byte-equivalent; every failure degrades to native Lily;
   `CAPABILITY-GATE.md` is only strengthened.

## Task P2B-1: Persona Persistence

**Files:**
- Modify: `src/main/store/schema.js` (migration v11)
- Create: `src/main/character-worlds/persona-model.js`
- Create: `src/main/character-worlds/persona-repository.js`
- Modify: `src/main/character-worlds/repository.js` (delegations)
- Create: `scripts/test-character-persona-store.mjs`

- [x] **Step 1: Write failing store tests**
  Mirror the world-book store suite: create persona entity + immutable
  revision (§7.3 shape: name, description, avatarAssetId), revision hash from
  canonical + provenance + assets, duplicate reuse, owner isolation, archive
  semantics, immutability triggers, Proxy/accessor/dangerous-key rejection,
  bounded fields, no authorization-shaped fields accepted (they are stripped
  inert or rejected — decide and document).
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Additive schema v11**
  `persona_entities` / `persona_revisions` / `persona_revision_blobs`
  mirroring the established discipline.
- [x] **Step 4: Persona model + repository**
  Bounded normalization; create/createRevision/get/getRevision/list/archive.
- [x] **Step 5: Run store + regression tests**
- [x] **Step 6: Commit** — `feat: add persona persistence`

## Task P2B-2: Persona Binding + Envelope

**Files:**
- Modify: `src/main/character-worlds/repository.js` (binding)
- Modify: `src/main/character-worlds/turn-binding-snapshot.js`
- Modify: `src/main/character-worlds/context-compiler.js`
- Modify: `src/main/character-worlds/turn-world-book.js` (or compiler shell)
- Modify: `src/main/ipc-character-worlds.js`, `src/preload.js`
- Create: `scripts/test-character-persona-context.mjs`

- [x] **Step 1: Write failing tests**
  Binding gains optional `personaRevisionId` (CAS, owner-scoped, immutable
  revision pinned); admission snapshot carries it (same transaction);
  compiler renders the persona narrative description in its §10.3.1 slot
  (below character identity, above constant world entries per §10.3 priority
  3) with explicit lower-authority labeling; missing/corrupt persona revision
  → compile without persona + diagnostic; native/no-persona byte-identical;
  persona never appears in user text/parts; redaction applies.
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Binding + snapshot extension**
  Additive nullable `persona_revision_id` on session bindings (schema v12);
  snapshot normalization + hashing extended; legacy rows normalize to null.
- [x] **Step 4: Compiler persona block**
  Typed envelope block in the §10.3.1 order; budget share below character
  identity; deterministic fingerprint.
- [x] **Step 5: IPC get/set persona binding**
  `session-character:set-binding` accepts optional personaRevisionId
  (validated, owner-scoped); read-only persona list/get channels for the UI.
- [x] **Step 6: Run context + orchestrator + gate regressions**
- [x] **Step 7: Commit** — `feat: bind personas into compiled context`

## Task P2B-3: Validated Authoring Domain APIs

**Files:**
- Create: `src/main/character-worlds/authoring-service.js`
- Modify: `src/main/character-worlds/service.js`
- Create: `scripts/test-character-authoring.mjs`

- [x] **Step 1: Write failing authoring tests**
  Create character/persona/world-book from blank canonical input (validated
  through the same models as import); edit = new revision with parent pin
  (book pin propagates); revision history list (newest-first, bounded);
  restore-as-new-revision (copy of an old revision becomes N+1 with explicit
  provenance); duplicate entity; archive/unarchive semantics per the current
  model (archive only, per Phase 1); delete = archive (no hard delete while
  references exist — §18 GC rule); all owner-scoped; all failures coded.
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Implement the authoring service**
  One validated entry point reused by IPC now and the agent later; every
  mutation transactional; revision/blob discipline reused.
- [x] **Step 4: Run authoring + import regressions**
- [x] **Step 5: Commit** — `feat: add validated character authoring apis`

## Task P2B-4: Authoring IPC + Library UI

**Files:**
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/preload.js`
- Create: `src/renderer/modules/character-library.js`
- Create: `src/renderer/styles/character-library.css`
- Modify: `src/renderer/modules/character-session-control.js`
- Modify: `src/renderer/i18n/locales/{zh-CN,en,ar}.json`
- Create: `scripts/test-character-authoring-ipc.mjs`
- Create: `scripts/test-character-library.cjs`

- [x] **Step 1: Write failing IPC tests**
  Guarded mutation channels (create/update-revision/restore/duplicate/
  archive) with trusted sender, owner derivation, payload bounds, stable
  codes; policy gate: authoring follows the same availability as import;
  no renderer owner scope.
- [x] **Step 2: Write failing Electron DOM tests**
  Library manager (replacing the disabled Phase 2 label): search + tag
  filter, create blank card, edit with explicit revision creation, revision
  history + restore, duplicate, archive, export, import report display
  (preserved vs unsupported inert counts); accessibility per §13.4.
- [x] **Step 3: Run tests, verify they fail**
- [x] **Step 4: Implement IPC channels + preload methods**
- [x] **Step 5: Implement the library UI**
  Opened from the session control popover (replacing the disabled item) and
  listing characters/personas/books read-first; editing is field-level with
  explicit revision creation; no marketing text; existing tokens/radii.
- [x] **Step 6: Run IPC + DOM + renderer regressions**
- [x] **Step 7: Commit** — `feat: add character library management`

## Task P2B-5: Switching Timeline Events + Update-Available

**Files:**
- Modify: `src/main/turn-orchestrator.js` (or a focused module)
- Modify: `src/renderer/modules/character-session-control.js`
- Modify: `src/renderer/i18n/locales/{zh-CN,en,ar}.json`
- Create: `scripts/test-character-switch-events.mjs`

- [x] **Step 1: Write failing tests**
  A committed binding change emits a conversation-visible timeline notice
  (switched to character X / returned to native Lily — names resolved
  main-side, never raw card data); events are binding-version ordered and
  survive restart (durable binding events feed the projection); an active
  character/persona receiving a newer revision surfaces "update available"
  in the session control WITHOUT changing the pinned snapshot; applying it
  is an explicit set-binding call with the current expectedBindingVersion;
  no greeting injection on selection (§8).
- [x] **Step 2: Run tests, verify they fail**
- [x] **Step 3: Implement main-side switch event projection**
  Reuse durable `getBindingEvents` (Phase 1) → renderer timeline notice
  through the runtime event channel (registered event type; do not reuse
  terminal types). (Implemented as renderer-side projection: the durable
  events feed `session-character:get-events`, which now also returns
  main-projected, name-resolved switch notices; the renderer replays them on
  binding load/settle and dedupes by bindingVersion, so reload durability is
  exact without a new runtime event type.)
- [x] **Step 4: Implement update-available indicator + apply flow**
- [x] **Step 5: Run switch + renderer regressions**
- [x] **Step 6: Commit** — `feat: surface character switching events`

## Task P2B-6: Capability Gate + Acceptance Extension

**Files:**
- Modify: `src/shared/capability-gates.json`, `CAPABILITY-GATE.md`
- Modify: `scripts/test-character-worlds-capability-gate.mjs`
- Modify: `scripts/test-character-worlds-concurrency-stress.mjs`
- Modify: `docs/character-worlds-phase-1-acceptance.md`

- [x] **Step 1: Extend the gate**
  Persona failure modes (missing/corrupt persona revision, over budget) →
  byte-equal no-persona compiled body; authoring mutation cannot alter an
  admitted turn's snapshot (admission isolation proof); guards registered
  (JSON + MD parity).
- [x] **Step 2: Extend the stress mix**
  Persona bind/edit/restore ops with deterministic fingerprints.
- [x] **Step 3: Extend the acceptance runbook**
  Phase 2B manual checks (persona select, library create/edit/history/
  restore/duplicate/archive, update-available apply flow, switch timeline
  notice, kill switch covers authoring).
- [x] **Step 4: Run the full matrix**
- [x] **Step 5: Commit** — `test: gate persona and authoring paths`

## Phase 2B Exit Criteria

- Personas are local, owner-scoped, immutable-revision pinned, narrative-only,
  and compile into the lower-authority envelope in the §10.3.1 slot.
- Every authoring mutation flows through one validated domain API and creates
  immutable revisions; history/restore never rewrites old revisions.
- Bound conversations stay pinned after edits; update-available requires an
  explicit apply.
- Switching writes ordered durable events and surfaces them in the
  conversation timeline; no greeting is ever injected into history.
- Native turns stay byte-equivalent; every new failure mode degrades per §16.
- Capability gate, stress, and runbook cover the new paths.
