# Character Worlds Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an independently releasable, conversation-scoped single-character compatibility foundation that imports safe Character Card data, snapshots immutable bindings at turn admission, injects bounded lower-authority context, and falls back exactly to native Lily on every failure.

**Architecture:** Character data is local-first and canonical in the existing MessageStore SQLite database. The main process owns validation, immutable revisions, compare-and-swap bindings, import/export, and per-turn compilation; the renderer uses narrow IPC only. Turn admission snapshots the exact binding and revision IDs before queueing, while OpenCode receives an optional dedicated system-context suffix that can never replace Lily guidance or visible user history.

**Tech Stack:** Electron main/preload/renderer, CommonJS Node.js, built-in SQLite wrapper, content-addressed BlobStore, OpenCode SDK prompt body, Fastify client-config service, plain Node test scripts.

---

## Scope And File Map

Phase 1 creates or changes these focused units:

- `src/main/character-worlds/constants.js`: versioned limits, compatibility profile, and kill-switch helpers.
- `src/main/character-worlds/validation.js`: bounded plain-object validation and canonical field normalization.
- `src/main/character-worlds/card-parser.js`: V1/V2/V3 JSON migration and compatibility report generation.
- `src/main/character-worlds/png-card.js`: bounded PNG/APNG chunk scanning and embedded card extraction.
- `src/main/character-worlds/macros.js`: deterministic lexer/parser/evaluator for the Phase 1 pure macro allowlist.
- `src/main/character-worlds/repository.js`: immutable entities/revisions, blob references, CAS bindings, events, and turn snapshots.
- `src/main/character-worlds/context-compiler.js`: lower-authority single-character envelope compilation with fail-open behavior.
- `src/main/character-worlds/service.js`: owner-scoped domain facade used by IPC and turn admission.
- `src/main/ipc-character-worlds.js`: validated IPC handlers.
- `src/renderer/modules/character-session-control.js`: conversation control and import-preview interaction.
- `src/renderer/styles/character-worlds.css`: compact composer control, picker, and import preview.
- `server/src/services/client-config.js`: signed remote policy fields for rollout and parser-profile selection.
- Existing wiring files: `src/main/store/schema.js`, `src/main/store/message-store.js`, `src/main/session-manager.js`, `src/main/turn-orchestrator.js`, `src/main/opencode-agent-session.js`, `src/main/runtime/opencode-server-manager.js`, `src/main/ipc-handlers.js`, `src/preload.js`, `src/main.js`, `src/renderer/index.html`, `src/renderer/app.js`, locale JSON, and `CAPABILITY-GATE.md`.

Phase 1 deliberately does not implement native card authoring, Persona editing, full world-book activation, episodic memory, groups, or response variants. Imported Persona/world-book payloads are preserved inertly for Phase 2/3 and reported accurately.

### Task 1: Add Character Worlds Schema And Immutable Repository

**Files:**
- Modify: `src/main/store/schema.js`
- Modify: `src/main/store/message-store.js`
- Create: `src/main/character-worlds/constants.js`
- Create: `src/main/character-worlds/repository.js`
- Create: `scripts/test-character-worlds-store.mjs`

- [x] **Step 1: Write the failing schema and repository tests**

Create `scripts/test-character-worlds-store.mjs` with cases that prove:

```js
const first = repository.createCharacter({
  ownerScope: "profile:local",
  canonical: { schemaVersion: 1, name: "Luna", description: "Navigator" },
  source: { format: "v2_json", preserved: { data: { name: "Luna" } } },
});
assert.equal(first.entity.currentRevisionId, first.revision.id);
assert.equal(repository.getRevision("profile:local", first.revision.id).canonical.name, "Luna");

assert.throws(
  () => repository.createRevision({
    ownerScope: "profile:local",
    entityId: first.entity.id,
    baseRevisionId: "stale",
    canonical: { schemaVersion: 1, name: "Changed" },
  }),
  (error) => error.code === "CHARACTER_REVISION_CONFLICT",
);

const native = repository.getBinding("session-a", "profile:local");
assert.deepEqual(native, {
  schemaVersion: 1,
  sessionId: "session-a",
  mode: "native",
  bindingVersion: 0,
  characterRevisionId: null,
  compatibilityProfile: null,
});
```

Also assert owner-scope isolation, immutable revision rows, additive migration from a v2 database, event append order, and reopen persistence.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-worlds-store.mjs
```

Expected: failure because `CharacterWorldsRepository` and schema v3 do not exist.

- [x] **Step 3: Append the additive MessageStore migration**

Append migration v3 in `src/main/store/schema.js`; never edit v1 or v2. The migration creates:

```sql
CREATE TABLE character_entities (
  id                  TEXT PRIMARY KEY,
  owner_scope         TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  archived_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_character_entities_owner
  ON character_entities(owner_scope, archived_at, updated_at);

CREATE TABLE character_revisions (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL,
  owner_scope       TEXT NOT NULL,
  parent_revision_id TEXT,
  revision_number   INTEGER NOT NULL,
  canonical_json    TEXT NOT NULL,
  source_json       TEXT NOT NULL,
  canonical_hash    TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_character_revision_hash
  ON character_revisions(owner_scope, entity_id, canonical_hash);

CREATE TABLE character_revision_blobs (
  revision_id TEXT NOT NULL,
  hash        TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  PRIMARY KEY (revision_id, hash, purpose)
);

CREATE TABLE character_session_bindings (
  session_id             TEXT PRIMARY KEY,
  owner_scope            TEXT NOT NULL,
  binding_version        INTEGER NOT NULL,
  mode                   TEXT NOT NULL,
  character_revision_id  TEXT,
  compatibility_profile  TEXT,
  binding_json            TEXT NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE character_binding_events (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  owner_scope           TEXT NOT NULL,
  binding_version       INTEGER NOT NULL,
  event_json            TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_character_binding_event_version
  ON character_binding_events(session_id, binding_version);

CREATE TABLE persona_entities (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  display_name TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE persona_revisions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE world_book_entities (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  display_name TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE world_book_revisions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE character_scene_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  turn_id TEXT,
  checkpoint_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

The stored canonical/source documents are gzip-packed through repository helpers, but remain bounded before insertion. Foreign keys are checked explicitly because existing MessageStore migrations do not enable SQLite foreign-key cascades.
Persona, world-book, and scene tables are forward-compatible storage only in Phase 1; no Phase 2/3 behavior is exposed yet. `binding_json` preserves the complete versioned binding envelope while indexed columns serve the single-character fast path.

- [x] **Step 4: Implement repository primitives**

`CharacterWorldsRepository` receives the existing `MessageStore` and uses `messageStore.db` plus `messageStore.blobs`. Implement:

```js
class CharacterWorldsRepository {
  constructor(messageStore) {
    if (!messageStore?.db || !messageStore?.blobs) {
      throw new TypeError("CharacterWorldsRepository requires MessageStore");
    }
    this.store = messageStore;
  }

  createCharacter({ ownerScope, canonical, source, assets = [] }) {}
  createRevision({ ownerScope, entityId, baseRevisionId, canonical, source, assets = [] }) {}
  listCharacters(ownerScope, options = {}) {}
  getCharacter(ownerScope, entityId) {}
  getRevision(ownerScope, revisionId) {}
  archiveCharacter(ownerScope, entityId) {}
  getBinding(sessionId, ownerScope) {}
  setBinding({ sessionId, ownerScope, expectedBindingVersion, next }) {}
  getBindingEvents(sessionId, ownerScope, options = {}) {}
  snapshotBindingForTurn({ sessionId, ownerScope, turnId, metadata }) {}
}
```

Use UUIDs, SHA-256 over stable canonical JSON, and one SQLite transaction per mutation. Write asset bytes to BlobStore before the SQL transaction, insert blob catalog/reference rows during the transaction, and leave only harmless content-addressed orphans after a rollback. A CAS mismatch throws `CHARACTER_BINDING_CONFLICT` and attaches the current binding.

- [x] **Step 5: Expose repository creation from MessageStore**

Add lazy construction to `MessageStore`:

```js
characterWorlds() {
  if (!this._characterWorlds) {
    const { CharacterWorldsRepository } = require("../character-worlds/repository");
    this._characterWorlds = new CharacterWorldsRepository(this);
  }
  return this._characterWorlds;
}
```

Do not instantiate or query Character Worlds during normal MessageStore startup beyond the additive migration.

- [x] **Step 6: Run focused store tests**

Run:

```bash
node scripts/test-character-worlds-store.mjs
node scripts/test-message-store.mjs
node scripts/test-session-store-split.mjs
```

Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add src/main/store/schema.js src/main/store/message-store.js \
  src/main/character-worlds/constants.js \
  src/main/character-worlds/repository.js \
  scripts/test-character-worlds-store.mjs
git commit -m "feat: add character worlds persistence"
```

### Task 2: Implement Bounded JSON Card Parsing And Compatibility Reports

**Files:**
- Create: `src/main/character-worlds/validation.js`
- Create: `src/main/character-worlds/card-parser.js`
- Create: `fixtures/character-worlds/v1-character.json`
- Create: `fixtures/character-worlds/v2-character.json`
- Create: `fixtures/character-worlds/v3-character.json`
- Create: `fixtures/character-worlds/hostile-depth.json`
- Create: `scripts/test-character-card-parser.mjs`

- [x] **Step 1: Write failing parser tests**

Test exact canonical output for V1, V2, and V3:

```js
const result = parseCharacterCard(buffer, {
  fileName: "v3-character.json",
  mime: "application/json",
});
assert.equal(result.ok, true);
assert.equal(result.format, "v3_json");
assert.equal(result.canonical.name, "Luna");
assert.equal(result.compatibility.level, "safe_behavior");
assert.deepEqual(result.compatibility.inertFields, ["data.extensions.stscript"]);
assert.equal(result.preserved.spec, "chara_card_v3");
```

Test malformed JSON, arrays at the root, `__proto__`/`constructor` keys, depth, field counts, oversized strings, 32 MiB file cap, 8 MiB embedded JSON cap, and preservation of unknown fields without executing them.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-card-parser.mjs
```

Expected: module-not-found failure for `card-parser.js`.

- [x] **Step 3: Implement bounded decoding and plain-data validation**

`validation.js` exports:

```js
function decodeJsonBuffer(buffer, limits = DEFAULT_IMPORT_LIMITS) {}
function assertPlainData(value, limits = DEFAULT_IMPORT_LIMITS) {}
function stableJson(value) {}
function cloneInert(value) {}
function normalizeString(value, maxChars, field) {}
function normalizeStringArray(value, limits, field) {}
```

Decode UTF-8 with a fatal `TextDecoder`; parse once; traverse iteratively with explicit maximum depth, object count, array length, key length, and total string characters. Reject dangerous keys at any depth and produce stable machine codes such as `CARD_TOO_LARGE`, `CARD_JSON_INVALID`, `CARD_DEPTH_EXCEEDED`, and `CARD_DANGEROUS_KEY`.

- [x] **Step 4: Implement V1/V2/V3 detection and migration**

`card-parser.js` recognizes:

```js
function detectFormat(root) {
  if (root?.spec === "chara_card_v3" || root?.spec_version === "3.0") return "v3_json";
  if (root?.spec === "chara_card_v2" || root?.spec_version === "2.0") return "v2_json";
  return "v1_json";
}
```

Canonical output contains only the approved Phase 1 fields:

```js
{
  schemaVersion: 1,
  name,
  description,
  personality,
  scenario,
  firstMessage,
  alternateGreetings,
  exampleDialogue,
  creatorNotes,
  systemPrompt,
  postHistoryInstructions,
  tags,
  creator,
  characterVersion,
}
```

Preserve the full sanitized source as inert data. Report every supported, migrated, preserved-inert, ignored-invalid, and rejected-executable path deterministically.

- [x] **Step 5: Run parser and fuzz-seed tests**

Run:

```bash
node scripts/test-character-card-parser.mjs
```

Expected: all parser fixtures pass and hostile fixtures fail with the exact bounded error code.

- [x] **Step 6: Commit**

```bash
git add src/main/character-worlds/validation.js \
  src/main/character-worlds/card-parser.js \
  fixtures/character-worlds \
  scripts/test-character-card-parser.mjs
git commit -m "feat: parse character card json safely"
```

### Task 3: Add Bounded PNG And APNG Card Extraction

**Files:**
- Create: `src/main/character-worlds/png-card.js`
- Create: `scripts/test-character-card-png.mjs`
- Create: `fixtures/character-worlds/v2-character.png`
- Create: `fixtures/character-worlds/v3-character.png`
- Create: `fixtures/character-worlds/v3-character.apng`

- [x] **Step 1: Write failing PNG/APNG tests**

Generate tiny deterministic fixtures in the test and assert:

```js
const embedded = extractEmbeddedCard(pngBuffer);
assert.equal(embedded.keyword, "ccv3");
assert.ok(embedded.json.length > 0);
assert.equal(parseCharacterCard(pngBuffer, { fileName: "card.png" }).canonical.name, "Luna");
```

Cover `tEXt`, compressed `zTXt`, UTF-8 `iTXt`, `chara`, `ccv3`, duplicate metadata precedence, CRC mismatch, truncated chunks, APNG animation chunks, decompression cap, 40-million-pixel cap, and unrelated PNG fallback.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-card-png.mjs
```

Expected: module-not-found failure for `png-card.js`.

- [x] **Step 3: Implement streaming chunk inspection**

`png-card.js` exports:

```js
function inspectPng(buffer, limits = DEFAULT_IMPORT_LIMITS) {}
function extractEmbeddedCard(buffer, limits = DEFAULT_IMPORT_LIMITS) {}
```

Validate the PNG signature, walk chunks without decoding pixels, enforce chunk count and byte limits, verify critical structure, read IHDR dimensions, and decompress only the exact supported text chunks with bounded zlib output. Never execute image metadata or follow external references.

- [x] **Step 4: Integrate image detection with the card parser**

`parseCharacterCard` dispatches by validated magic bytes, not extension. If a PNG has no recognized card payload, return `NOT_A_CHARACTER_CARD` so the caller can fail open to Lily's ordinary image attachment path.

- [x] **Step 5: Run focused image tests**

Run:

```bash
node scripts/test-character-card-png.mjs
node scripts/test-vision-translator.mjs
node scripts/test-image-send-flow.mjs
```

Expected: all pass; ordinary images remain unchanged.

- [x] **Step 6: Commit**

```bash
git add src/main/character-worlds/png-card.js \
  src/main/character-worlds/card-parser.js \
  fixtures/character-worlds \
  scripts/test-character-card-png.mjs
git commit -m "feat: import character cards from png"
```

### Task 4: Implement Safe Deterministic Macros

**Files:**
- Create: `src/main/character-worlds/macros.js`
- Create: `scripts/test-character-macros.mjs`

- [x] **Step 1: Write failing macro tests**

Test deterministic expansion:

```js
assert.equal(
  expandSafeMacros("Hello {{user}}, I am {{char}}.", {
    user: "Alex",
    char: "Luna",
    seed: "turn-1",
  }).text,
  "Hello Alex, I am Luna.",
);

assert.equal(
  expandSafeMacros("{{random::red::blue::green}}", { seed: "turn-1" }).text,
  expandSafeMacros("{{random::red::blue::green}}", { seed: "turn-1" }).text,
);

assert.deepEqual(
  expandSafeMacros("{{unknown::x}} {{exec::rm}}", { seed: "turn-1" }).warnings,
  [
    { code: "MACRO_UNKNOWN", name: "unknown" },
    { code: "MACRO_BLOCKED", name: "exec" },
  ],
);
```

Also cover escapes, malformed delimiters, nesting depth, output cap, empty options, locale-independent date inputs, and no access to filesystem/network/environment.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-macros.mjs
```

Expected: module-not-found failure.

- [x] **Step 3: Implement lexer, parser, and evaluator**

Export:

```js
function lexMacros(text, limits) {}
function parseMacros(tokens, limits) {}
function expandSafeMacros(text, context, limits = DEFAULT_MACRO_LIMITS) {}
```

Allow only pure handlers: `user`, `char`, `original`, `time`, `date`, `weekday`, `isotime`, `isodate`, `idle_duration`, `random`, `roll`, `pick`, and whitespace/case transforms explicitly listed in the design. Unknown or blocked macros remain literal and produce warnings. Randomness uses SHA-256 counter output from the supplied turn seed; never use `Math.random()`.

- [x] **Step 4: Run deterministic and hostile macro tests**

Run:

```bash
node scripts/test-character-macros.mjs
```

Expected: all pass with no clock dependence unless a fixed `now` is supplied.

- [x] **Step 5: Commit**

```bash
git add src/main/character-worlds/macros.js scripts/test-character-macros.mjs
git commit -m "feat: add safe character macros"
```

### Task 5: Build Import Preview, Commit, And Export Domain Service

**Files:**
- Create: `src/main/character-worlds/service.js`
- Create: `scripts/test-character-worlds-import.mjs`

- [x] **Step 1: Write failing preview/commit tests**

Prove preview is side-effect free and commit requires the exact preview token:

```js
const preview = service.previewImport({
  ownerScope: "profile:local",
  sourcePath: fixturePath,
});
assert.equal(preview.ok, true);
assert.equal(repository.listCharacters("profile:local").length, 0);

const committed = service.commitImport({
  ownerScope: "profile:local",
  previewToken: preview.previewToken,
});
assert.equal(committed.entity.currentRevisionId, committed.revision.id);

assert.throws(
  () => service.commitImport({ ownerScope: "profile:local", previewToken: preview.previewToken }),
  (error) => error.code === "IMPORT_PREVIEW_EXPIRED",
);
```

Also test source-file fingerprint changes, expiry, account change, path traversal, symlinks, ordinary attachment fallback, exact source preservation, and V2/V3 export re-import.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-worlds-import.mjs
```

Expected: module-not-found failure for `service.js`.

- [x] **Step 3: Implement owner-scoped preview cache**

`CharacterWorldsService` receives `messageStore`, `resolveOwnerScope`, and `now`. Preview reads one bounded local file, fingerprints path/size/mtime/SHA-256, parses it, and stores only an expiring in-memory record keyed by a random 256-bit token. Commit rechecks the fingerprint and owner scope before persistence. Restart invalidates previews safely.

- [x] **Step 4: Implement lossless safe export**

Export defaults to the preserved original standard when possible. If canonical data changed, emit V3 JSON with inert unknown fields preserved under their original safe paths and executable fields still inert. Output paths are selected through the existing save-dialog/path-guard flow; renderer input never supplies an unrestricted destination.

- [x] **Step 5: Run import/export tests**

Run:

```bash
node scripts/test-character-worlds-import.mjs
node scripts/test-file-staging-manager.mjs
node scripts/test-path-guard.mjs
```

Expected: all pass.

- [x] **Step 6: Commit**

```bash
git add src/main/character-worlds/service.js \
  scripts/test-character-worlds-import.mjs
git commit -m "feat: add character import preview flow"
```

### Task 6: Snapshot Bindings Atomically At Turn Admission

**Files:**
- Modify: `src/main/store/message-store.js`
- Modify: `src/main/session-manager.js`
- Modify: `src/main/turn-orchestrator.js`
- Create: `scripts/test-character-binding-isolation.mjs`

- [x] **Step 1: Write failing admission and concurrency tests**

Cover send/switch/send, queued turns, scheduled turns, concurrent sessions, steering, restart, and missing revision:

```js
const first = sessionManager.admitTurnInput("session-a", {
  turnId: "turn-1",
  userText: "before switch",
  metadata: {},
});
service.setBinding("session-a", {
  expectedBindingVersion: 1,
  characterRevisionId: secondRevision.id,
});
const second = sessionManager.admitTurnInput("session-a", {
  turnId: "turn-2",
  userText: "after switch",
  metadata: {},
});

assert.equal(first.metadata.characterWorlds.characterRevisionId, firstRevision.id);
assert.equal(second.metadata.characterWorlds.characterRevisionId, secondRevision.id);
assert.equal(first.metadata.characterWorlds.bindingVersion, 1);
assert.equal(second.metadata.characterWorlds.bindingVersion, 2);
```

Force transaction-boundary interleavings and prove another session's binding is never observed.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-binding-isolation.mjs
```

Expected: admitted metadata lacks `characterWorlds`.

- [x] **Step 3: Extend `MessageStore.admitTurnInput` transaction**

Inside the existing transaction, resolve the binding by exact `session_id` and host-derived owner scope, validate the immutable revision still exists, and merge this bounded snapshot:

```js
metadata.characterWorlds = {
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 3,
  characterRevisionId: "revision-id",
  compatibilityProfile: "lily-character-compat-1",
  snapshotStatus: "ready",
};
```

Native mode writes no Character Worlds metadata, preserving byte-equivalent legacy admission. A corrupt/missing binding records `snapshotStatus: "fallback"` and no active revision, then continues.

- [x] **Step 4: Pass owner scope through SessionManager**

`SessionManager.admitTurnInput` derives owner scope from the authenticated local profile/session context already owned by main process. Callers cannot submit `ownerScope`. Scheduled tasks, mobile commands, and renderer sends continue through the same method.

- [x] **Step 5: Reuse snapshots for queue, retry, recovery, and steer**

Turn state stores the admitted snapshot once. Queue promotion, safe replay, model self-heal, continuation, and evidence recovery reuse it. Steering inherits the active turn's snapshot and never reads the latest binding.

- [x] **Step 6: Run isolation regression tests**

Run:

```bash
node scripts/test-character-binding-isolation.mjs
node scripts/test-turn-orchestrator.mjs
node scripts/test-scheduled-task-isolation.mjs
node scripts/test-external-command-admission.mjs
node scripts/test-resume-binding.mjs
```

Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add src/main/store/message-store.js src/main/session-manager.js \
  src/main/turn-orchestrator.js scripts/test-character-binding-isolation.mjs
git commit -m "feat: snapshot character bindings per turn"
```

### Task 7: Compile Bounded Lower-Authority Character Context

**Files:**
- Create: `src/main/character-worlds/context-compiler.js`
- Modify: `src/main/runtime/opencode-server-manager.js`
- Modify: `src/main/opencode-agent-session.js`
- Modify: `src/main/turn-orchestrator.js`
- Create: `scripts/test-character-context-compiler.mjs`
- Create: `scripts/test-character-context-injection.mjs`

- [x] **Step 1: Write failing compiler tests**

Assert native byte equivalence and protected-priority budgeting:

```js
assert.deepEqual(
  compileCharacterContext({ snapshot: null, userText: "hello" }),
  { status: "native", text: "", fingerprint: null, warnings: [] },
);

const compiled = compileCharacterContext({
  snapshot,
  revision,
  userText: "prepare the report",
  modelBudget: { usableInputTokens: 32768, remainingInputTokens: 12000 },
});
assert.equal(compiled.status, "compiled");
assert.ok(compiled.tokenEstimate <= 8192);
assert.match(compiled.text, /lower-authority narrative context/i);
assert.doesNotMatch(compiled.text, /disable tools|ignore permission/i);
```

Test expression profiles `immersive`, `balanced`, and `task_preserving`; ambiguous work defaults to `task_preserving`. Verify exact values, paths, commands, code, JSON, citations, formulas, and tool inputs are outside style transformation.

- [x] **Step 2: Write failing OpenCode injection tests**

Capture the SDK prompt body and assert:

```js
assert.equal(nativeBody.system, baselineBody.system);
assert.equal(nativeBody.parts, baselineBody.parts);
assert.ok(roleBody.system.startsWith(baselineBody.system));
assert.match(roleBody.system, /CHARACTER WORLDS CONTEXT/);
assert.doesNotMatch(JSON.stringify(roleBody.parts), /CHARACTER WORLDS CONTEXT/);
```

Provider-without-safe-system-context must receive the native body unchanged.

- [x] **Step 3: Run both tests and verify they fail**

Run:

```bash
node scripts/test-character-context-compiler.mjs
node scripts/test-character-context-injection.mjs
```

Expected: compiler missing and prompt body lacks a separate character context.

- [x] **Step 4: Implement the context compiler**

Compile from the admitted revision only. Expand safe macros in fixed phases, classify expression profile before adding narrative data, redact blocked imperative patterns from low-authority imported fields, and pack in this order:

```text
identity/name
task-integrity boundary
description/personality
scenario
example dialogue
systemPrompt/postHistoryInstructions (explicitly labeled imported narrative)
```

Character ceiling is `min(remainingInputTokens, floor(usableInputTokens * 0.25), 16384)`. Use the active tokenizer when exposed by the existing context budget manager; otherwise use its conservative estimator. On any exception return native status and emit metadata-only diagnostics.

- [x] **Step 5: Add a dedicated OpenCode request field**

Extend the internal send payload:

```js
{
  text,
  files,
  guidance,
  characterContext: compiled.status === "compiled" ? compiled : null,
}
```

`runtime/opencode-server-manager.js` appends a delimited suffix to the system field after protected Lily guidance. It never concatenates the suffix to text/file parts or persisted history. Preserve the existing guidance bytes exactly when `characterContext` is absent, disabled, invalid, oversized, or unsupported by provider capabilities.

- [x] **Step 6: Wire turn compilation after admission and before dispatch**

Resolve the immutable revision named by `state.characterWorldsSnapshot`; do not read the current binding. Store only fingerprint, revision ID, profile, activated field list, omissions, and warnings in turn metadata. Never log card contents.

- [x] **Step 7: Run compiler, injection, and agent regressions**

Run:

```bash
node scripts/test-character-context-compiler.mjs
node scripts/test-character-context-injection.mjs
node scripts/test-opencode-agent-session.mjs
node scripts/test-opencode-server-manager.mjs
node scripts/test-context-budget-manager.mjs
node scripts/test-opencode-message-parts.mjs
```

Expected: all pass.

- [x] **Step 8: Commit**

```bash
git add src/main/character-worlds/context-compiler.js \
  src/main/runtime/opencode-server-manager.js src/main/opencode-agent-session.js \
  src/main/turn-orchestrator.js \
  scripts/test-character-context-compiler.mjs \
  scripts/test-character-context-injection.mjs
git commit -m "feat: inject bounded character context"
```

### Task 8: Expose Narrow IPC And Preload APIs

**Files:**
- Create: `src/main/ipc-character-worlds.js`
- Modify: `src/main/ipc-handlers.js`
- Modify: `src/preload.js`
- Modify: `src/main.js`
- Create: `scripts/test-character-worlds-ipc.mjs`

- [x] **Step 1: Write failing IPC contract tests**

Assert the exposed bridge contains only:

```js
[
  "listCharacters",
  "getCharacter",
  "previewCharacterImport",
  "commitCharacterImport",
  "exportCharacter",
  "getSessionCharacterBinding",
  "setSessionCharacterBinding",
  "getSessionCharacterEvents",
]
```

Verify renderer-supplied owner/account IDs are rejected, arbitrary output paths are absent, payload bytes/IDs are bounded, stale CAS returns current state, and unknown sessions cannot be mutated.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-worlds-ipc.mjs
```

Expected: channels are not registered.

- [x] **Step 3: Implement main-process handlers**

Use existing `register*Ipc` conventions and `assertTrustedSender`/session lookup helpers. Resolve owner scope and session authority from host state. Map domain errors to stable renderer-safe results:

```js
{ ok: false, error: "CHARACTER_BINDING_CONFLICT", currentBinding }
{ ok: false, error: "NOT_A_CHARACTER_CARD", fallback: "ordinary_attachment" }
{ ok: false, error: "CARD_TOO_LARGE" }
```

No stack traces, card content, local secrets, or unrestricted paths cross to renderer.

- [x] **Step 4: Add the preload facade**

Expose one frozen `characterWorlds` object using `ipcRenderer.invoke`. Do not expose raw channel names or generic invoke.

- [x] **Step 5: Wire service startup and teardown**

Construct one `CharacterWorldsService` from the existing MessageStore and inject it into IPC and Turn Orchestrator context. Service state is immutable/cache-only; there is no mutable global current character.

- [x] **Step 6: Run IPC and preload tests**

Run:

```bash
node scripts/test-character-worlds-ipc.mjs
node scripts/test-assistant-ipc-routing.mjs
node scripts/test-renderer-import.cjs
```

Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add src/main/ipc-character-worlds.js src/main/ipc-handlers.js \
  src/preload.js src/main.js scripts/test-character-worlds-ipc.mjs
git commit -m "feat: expose character worlds ipc"
```

### Task 9: Add The Conversation-Level Renderer Experience

**Files:**
- Create: `src/renderer/modules/character-session-control.js`
- Create: `src/renderer/styles/character-worlds.css`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Create: `scripts/test-character-session-control.mjs`
- Create: `scripts/test-character-session-control.cjs`

- [x] **Step 1: Write failing renderer model tests**

Test pure state transitions:

```js
const state = reduceCharacterControl(initialState, {
  type: "binding.loaded",
  sessionId: "session-a",
  binding: { mode: "character", bindingVersion: 2, characterRevisionId: "rev-a" },
});
assert.equal(state.mode, "character");

const conflicted = reduceCharacterControl(state, {
  type: "binding.conflict",
  currentBinding: { mode: "native", bindingVersion: 3 },
});
assert.equal(conflicted.mode, "native");
assert.equal(conflicted.bindingVersion, 3);
```

Cover rapid session switching, stale async responses, import warnings, corrupt card fallback, switch while turn runs, long CJK/RTL names, and native mode.

- [x] **Step 2: Write failing Electron DOM tests**

Assert the composer toolbar has an icon button with tooltip/accessible name, picker focus trapping, keyboard selection, import preview confirmation, conflict reconciliation, no nested cards, and no layout shift when labels change.

- [x] **Step 3: Run tests and verify they fail**

Run:

```bash
node scripts/test-character-session-control.mjs
npx electron scripts/test-character-session-control.cjs
```

Expected: renderer module/control is absent.

- [x] **Step 4: Implement the compact conversation control**

Add a Lucide `UserRound` icon button beside session skills. The button displays a small avatar swatch when bound and an unselected icon in native mode. Its popover provides:

```text
Lily 原声 / Native Lily
recent local characters
import character card
manage library (disabled with a clear Phase 2 label only if necessary)
```

Do not add explanatory feature marketing text. Selection is conversation-scoped and sends `expectedBindingVersion`.

- [x] **Step 5: Implement import preview**

Preview shows name, avatar, detected format, compatibility level, supported field count, inert field count, and security warnings. Commit requires an explicit command button. `NOT_A_CHARACTER_CARD` closes the flow and restores the existing ordinary attachment behavior.

- [x] **Step 6: Add localized strings and responsive CSS**

Use existing colors and 8px-or-less radii. Provide visible focus, `aria-live` status, 44px compact touch targets, ellipsis plus title for long names, RTL-safe layout, and stable toolbar dimensions. Do not use gradients, decorative cards, or purple-dominant styling.

- [x] **Step 7: Run renderer tests**

Run:

```bash
node scripts/test-character-session-control.mjs
npx electron scripts/test-character-session-control.cjs
node scripts/test-renderer-css-tokens.mjs
node scripts/test-i18n-non-zh-leaks.mjs
```

Expected: all pass.

- [x] **Step 8: Commit**

```bash
git add src/renderer/modules/character-session-control.js \
  src/renderer/styles/character-worlds.css src/renderer/index.html \
  src/renderer/app.js src/renderer/i18n/locales/zh-CN.json \
  src/renderer/i18n/locales/en.json \
  scripts/test-character-session-control.mjs \
  scripts/test-character-session-control.cjs
git commit -m "feat: add session character control"
```

### Task 10: Add Signed Rollout Policy Without Uploading Private Character Data

**Files:**
- Modify: `server/src/services/client-config.js`
- Modify: `src/main/remote-config.js`
- Modify: `src/main/character-worlds/constants.js`
- Create: `scripts/test-character-worlds-policy.mjs`

- [x] **Step 1: Write failing policy tests**

Assert server config emits:

```js
{
  characterWorlds: {
    enabled: false,
    compatibilityProfile: "lily-character-compat-1",
    minimumClientVersion: "0.1.145",
  },
}
```

Prove invalid/unsigned/stale policy disables Character Worlds compilation but preserves local data and bindings. `LILY_CHARACTER_WORLDS=0` always wins as the emergency kill switch; no remote field can enable executable imports or weaken hard limits.

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
node scripts/test-character-worlds-policy.mjs
```

Expected: client config has no Character Worlds policy.

- [x] **Step 3: Add bounded server policy**

Read policy from validated server environment/config with conservative defaults. Include it in the existing signed client-config payload. Do not add character CRUD endpoints, private content upload, card analytics, or server-side user libraries.

- [x] **Step 4: Resolve effective local policy**

`constants.js` returns:

```js
function characterWorldsPolicy(remoteConfig) {
  if (process.env.LILY_CHARACTER_WORLDS === "0") return { enabled: false, reason: "kill_switch" };
  if (!remoteConfig?.characterWorlds?.enabled) return { enabled: false, reason: "remote_disabled" };
  return {
    enabled: true,
    compatibilityProfile: SUPPORTED_PROFILES.has(remoteConfig.characterWorlds.compatibilityProfile)
      ? remoteConfig.characterWorlds.compatibilityProfile
      : DEFAULT_COMPATIBILITY_PROFILE,
  };
}
```

Policy failure affects compilation/selection availability only; import data and bindings remain stored and readable.

- [x] **Step 5: Run service and policy tests**

Run:

```bash
node scripts/test-character-worlds-policy.mjs
node scripts/test-client-config-service.mjs
node scripts/test-service-client.mjs
node scripts/test-remote-config-gateway-token-expiry.mjs
```

Expected: all pass.

- [x] **Step 6: Commit**

```bash
git add server/src/services/client-config.js src/main/remote-config.js \
  src/main/character-worlds/constants.js \
  scripts/test-character-worlds-policy.mjs
git commit -m "feat: add character worlds rollout policy"
```

### Task 11: Close The Capability Gate And Release Acceptance

**Files:**
- Modify: `CAPABILITY-GATE.md`
- Modify: `src/shared/capability-gates.json`
- Create: `scripts/test-character-worlds-capability-gate.mjs`
- Create: `scripts/test-character-worlds-concurrency-stress.mjs`
- Create: `docs/character-worlds-phase-1-acceptance.md`

- [x] **Step 1: Write the closed-loop capability test**

Test a native control payload against all Phase 1 feature failure modes:

```js
for (const failure of [
  "disabled",
  "missing_binding",
  "missing_revision",
  "parser_error",
  "macro_error",
  "compiler_error",
  "over_budget",
  "provider_unsupported",
]) {
  const actual = await dispatchWithCharacterFailure(failure);
  assert.deepEqual(actual.promptBody, baseline.promptBody, failure);
  assert.equal(actual.dispatchCount, 1, failure);
}
```

Also assert tools, skill IDs, model, permission mode, files, evidence context, subagent surface, current user text, and output reserve are identical to native Lily.

- [x] **Step 2: Write deterministic concurrency stress**

Use a seeded scheduler to execute 10,000 randomized operations across at least 32 sessions:

```text
bind A
admit turn
bind B
queue scheduled turn
steer
retry
restart/reopen database
archive character
read snapshot
```

Every admitted turn must resolve only its exact stored session/revision/version; duplicate event versions, cross-session revisions, and mutable queued snapshots fail the test.

- [x] **Step 3: Run new gate tests and verify they fail before registry changes**

Run:

```bash
node scripts/test-character-worlds-capability-gate.mjs
node scripts/test-character-worlds-concurrency-stress.mjs
node scripts/test-capability-gate-registry.mjs
```

Expected: capability tests pass after implementation; registry test fails until the new vector is registered.

- [x] **Step 4: Register the new capability vector**

Add a machine-readable registry entry and matching `CAPABILITY-GATE.md` row:

```text
Character card parsing, session binding, or context compilation changes a native
turn, crosses conversations, displaces Lily guidance, exposes private card data,
or lets imported executable behavior run.
```

Guards are the Character Worlds tests: store, parser, binding isolation, context injection, capability gate, concurrency stress, and rollout policy.

- [x] **Step 5: Write acceptance runbook**

Document exact manual checks for macOS arm64/x64 and Windows x64:

```text
native conversation unchanged
V1/V2/V3 JSON import
V2/V3 PNG/APNG import
preview cancellation
character selection and removal
switch during running turn
send/switch/send queue ordering
two conversations in parallel
scheduled task exact-session behavior
restart recovery
malformed/oversized/hostile card fallback
provider without safe system context
kill switch
privacy inspection
CJK/RTL/zoom/keyboard/screen-reader layout
```

State that Phase 1 is not complete until all automated gates pass and manual cross-platform checks are recorded with evidence.

- [x] **Step 6: Run the full verification matrix**

Run:

```bash
node scripts/test-character-worlds-store.mjs
node scripts/test-character-card-parser.mjs
node scripts/test-character-card-png.mjs
node scripts/test-character-macros.mjs
node scripts/test-character-worlds-import.mjs
node scripts/test-character-binding-isolation.mjs
node scripts/test-character-context-compiler.mjs
node scripts/test-character-context-injection.mjs
node scripts/test-character-worlds-ipc.mjs
node scripts/test-character-session-control.mjs
npx electron scripts/test-character-session-control.cjs
node scripts/test-character-worlds-policy.mjs
node scripts/test-character-worlds-capability-gate.mjs
node scripts/test-character-worlds-concurrency-stress.mjs
npm run test:capability-gate
npm run test:unit
```

Expected: all Character Worlds tests and Capability Gate pass. Full-suite environment skips or failures must be reported individually; no release claim is allowed while a product-relevant failure remains.

- [x] **Step 7: Commit**

```bash
git add CAPABILITY-GATE.md src/shared/capability-gates.json \
  scripts/test-character-worlds-capability-gate.mjs \
  scripts/test-character-worlds-concurrency-stress.mjs \
  docs/character-worlds-phase-1-acceptance.md
git commit -m "test: close character worlds capability gate"
```

## Phase 1 Exit Criteria

- Native mode sends byte-equivalent Lily/OpenCode prompt bodies and performs no card parsing or extra model request.
- Character bindings are local, optional, immutable-revision pinned, conversation-scoped, owner-scoped, and snapshotted in the same transaction as turn admission.
- V1/V2/V3 JSON and V2/V3 PNG/APNG imports are bounded, previewed, preserve safe unknown data inertly, and never execute imported scripts/plugins/macros.
- Character context is lower authority, separately budgeted, never visible history, and fully removable by policy/kill switch/failure.
- Renderer selection/import flows are accessible, localized, responsive, and reconcile CAS conflicts.
- Server controls signed rollout only and never stores private card content.
- Capability Gate, concurrency stress, focused regressions, and cross-platform release acceptance are complete.
