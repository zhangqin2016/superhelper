# Character Worlds Unified Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a natural-language create, durable result, current-conversation preview, refinement, and explicit activation loop for characters, personas, and world books without reducing native Lily capabilities.

**Architecture:** Add host-owned receipt and preview services over additive SQLite tables, evolve the binding into an independently composable conversation configuration, and snapshot the effective durable-plus-preview configuration at turn admission. Renderer receives only safe receipt blocks and opaque action tokens; the existing Character Worlds compiler remains the lower-authority runtime boundary and fails back facet-by-facet to the durable or native configuration.

**Tech Stack:** Electron main/preload/renderer, CommonJS main-process services, ES modules in renderer, `node:sqlite` through `MessageStore`, existing Character Worlds repositories and runtime, Node test scripts auto-discovered by `scripts/run-all-tests.mjs`.

---

## File Structure

New files have one responsibility each:

- `src/main/store/character-worlds-experience-schema-migration.js`: additive receipt, preview, and admitted-snapshot schema.
- `src/main/character-worlds/conversation-config.js`: normalize, validate, compose, and compare durable/preview configurations.
- `src/main/character-worlds/preview-store.js`: owner/session-scoped preview CAS and atomic activation support.
- `src/main/character-worlds/receipt-store.js`: durable safe receipt records and owner-scoped lookup.
- `src/main/character-worlds/receipt-actions.js`: short-lived single-purpose action-token issue/consume logic.
- `src/main/character-worlds/draft-receipt.js`: validate successful `lily_character_draft` evidence and create a result block.
- `src/main/character-worlds/experience-observability.js`: emit metadata-only lifecycle diagnostics through an injected sink.
- `src/renderer/modules/character-result-card.js`: render receipt blocks and dispatch actions.
- `src/renderer/modules/character-preview-banner.js`: render and reconcile current preview state.

Existing files retain their current responsibilities:

- `src/main/character-worlds/repository.js`: durable binding and book-binding transaction boundary.
- `src/main/character-worlds/turn-binding-snapshot.js`: immutable admitted effective configuration.
- `src/main/character-worlds/runtime.js`: admission and runtime fallback.
- `src/main/ipc-character-worlds.js`: trusted IPC boundary.
- `src/main/required-tool-completion.js`: required-tool success evidence.
- `src/main/turn-terminal-finalizer.js`: attach validated result blocks before committing the assistant turn.
- `src/preload.js`: narrow renderer bridge.
- `src/renderer/modules/content-blocks.js`: typed result-block routing.
- `src/renderer/modules/character-control-model.js`: pure session UI state.
- `src/renderer/modules/character-session-control.js`: bind IPC state to the active conversation.

## Task 1: Add the Durable Experience Schema

**Files:**
- Create: `src/main/store/character-worlds-experience-schema-migration.js`
- Modify: `src/main/store/schema.js`
- Test: `scripts/test-character-worlds-experience-migration.mjs`

- [ ] **Step 1: Write the failing migration test**

Create a v14 database, migrate it, and assert the new tables, indexes, immutable
receipt trigger, one-preview-per-owner/session constraint, and admitted snapshot
column exist:

```js
assert.deepEqual(tableColumns(db, "character_worlds_receipts"), [
  "id", "owner_scope", "session_id", "turn_id", "tool_call_id", "kind",
  "entity_id", "revision_id", "safe_json", "created_at",
]);
assert.ok(indexNames(db).includes("idx_character_worlds_receipt_turn"));
assert.ok(indexNames(db).includes("idx_character_session_preview_owner"));
assert.ok(tableColumns(db, "turn_inputs").includes("character_worlds_snapshot_json"));
assert.throws(() => db.run(
  "UPDATE character_worlds_receipts SET revision_id = 'changed' WHERE id = ?", receiptId,
), /immutable/);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node scripts/test-character-worlds-experience-migration.mjs`

Expected: FAIL because migration v15 and the three schema additions do not exist.

- [ ] **Step 3: Implement the additive migration**

Export one migration function and append it to `MIGRATIONS`:

```js
function migrateCharacterWorldsExperienceSchema(db) {
  db.exec(`
    CREATE TABLE character_worlds_receipts (
      id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('character', 'persona', 'worldBook')),
      entity_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      safe_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(owner_scope, session_id, turn_id, tool_call_id)
    );
    CREATE INDEX idx_character_worlds_receipt_turn
      ON character_worlds_receipts(owner_scope, session_id, turn_id);
    CREATE TRIGGER character_worlds_receipts_no_update
      BEFORE UPDATE ON character_worlds_receipts BEGIN
        SELECT RAISE(ABORT, 'character_worlds_receipts are immutable');
      END;
    CREATE TRIGGER character_worlds_receipts_no_delete
      BEFORE DELETE ON character_worlds_receipts BEGIN
        SELECT RAISE(ABORT, 'character_worlds_receipts are immutable');
      END;
    CREATE TABLE character_session_previews (
      session_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      preview_version INTEGER NOT NULL,
      preview_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, owner_scope)
    );
    CREATE INDEX idx_character_session_preview_owner
      ON character_session_previews(owner_scope, session_id);
    ALTER TABLE turn_inputs ADD COLUMN character_worlds_snapshot_json TEXT;
  `);
}
```

- [ ] **Step 4: Run migration and legacy tests**

Run: `node scripts/test-character-worlds-experience-migration.mjs && node scripts/test-turn-admission-migration.mjs && node scripts/test-character-worlds-store.mjs`

Expected: all PASS; a v14 database retains every existing binding and entity.

- [ ] **Step 5: Commit**

```bash
git add src/main/store/character-worlds-experience-schema-migration.js src/main/store/schema.js scripts/test-character-worlds-experience-migration.mjs
git commit -m "feat: add character worlds experience schema"
```

## Task 2: Define Independent Conversation Configuration

**Files:**
- Create: `src/main/character-worlds/conversation-config.js`
- Modify: `src/main/character-worlds/repository.js`
- Modify: `src/main/character-worlds/binding-projection.js`
- Test: `scripts/test-character-conversation-config.mjs`
- Test: `scripts/test-character-binding-isolation.mjs`

- [ ] **Step 1: Write failing configuration tests**

Cover native Lily plus persona, native Lily plus multiple books, character plus all
facets, exact deduplication, owner validation, and stale CAS:

```js
assert.deepEqual(normalizeConversationConfig({ personaRevisionId: "persona-1" }), {
  characterRevisionId: null,
  personaRevisionId: "persona-1",
  books: [],
  greetingIndex: null,
  sceneId: null,
  groupId: null,
});
assert.equal(configMode({ characterRevisionId: null }), "native");
assert.deepEqual(dedupeBooks([
  { scope: "chat", worldBookRevisionId: "book-1", mergeStrategy: "constant" },
  { scope: "chat", worldBookRevisionId: "book-1", mergeStrategy: "constant" },
]).length, 1);
assert.throws(() => repo.setConversationConfig({
  sessionId, ownerScope, expectedBindingVersion: 0,
  next: { personaRevisionId: foreignPersonaRevisionId },
}), /PERSONA_REVISION_NOT_FOUND/);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-conversation-config.mjs`

Expected: FAIL because native mode currently discards persona and book selection.

- [ ] **Step 3: Implement the pure configuration contract**

Export this stable interface:

```js
module.exports = {
  CONFIG_SCHEMA_VERSION: 2,
  configMode,
  dedupeBooks,
  emptyConversationConfig,
  normalizeConversationConfig,
  validateConversationConfig,
};
```

`normalizeConversationConfig` must preserve persona/books when character is null,
clear greeting/scene/group only when their character dependency is absent, reject
unknown keys and dangerous prototypes, and freeze the returned value.

- [ ] **Step 4: Add the atomic repository writer**

Add `setConversationConfig` and make legacy `setBinding` delegate to it:

```js
setConversationConfig({ sessionId, ownerScope, expectedBindingVersion, next, clearPreview = false }) {
  return this.db.transaction(() => {
    const current = this.getConversationConfig(sessionId, ownerScope);
    if (current.bindingVersion !== expectedBindingVersion) {
      throw codedError("CHARACTER_BINDING_CONFLICT", "Binding version is stale", { current });
    }
    const validated = validateConversationConfig(this.db, ownerScope, next);
    const committed = this._writeConversationConfig(sessionId, ownerScope, current, validated);
    if (clearPreview) this.db.run(
      "DELETE FROM character_session_previews WHERE session_id = ? AND owner_scope = ?",
      sessionId, ownerScope,
    );
    return committed;
  })();
}
```

Add `getConversationConfig(sessionId, ownerScope)` to read the binding row plus
ordered book rows, and `_writeConversationConfig(sessionId, ownerScope, current,
validated)` to write both sets and append one binding event. Write binding and
ordered book rows in this same transaction. Preserve the current append-only
binding event contract and derive compatibility `mode` from the character pin only.

- [ ] **Step 5: Run focused tests**

Run: `node scripts/test-character-conversation-config.mjs && node scripts/test-character-binding-isolation.mjs && node scripts/test-character-switch-events.mjs && node scripts/test-character-world-multi-book-wiring.mjs`

Expected: all PASS, including legacy `setBinding` callers.

- [ ] **Step 6: Commit**

```bash
git add src/main/character-worlds/conversation-config.js src/main/character-worlds/repository.js src/main/character-worlds/binding-projection.js scripts/test-character-conversation-config.mjs scripts/test-character-binding-isolation.mjs
git commit -m "feat: compose character worlds conversation config"
```

## Task 3: Implement Persistent Preview CAS

**Files:**
- Create: `src/main/character-worlds/preview-store.js`
- Modify: `src/main/character-worlds/repository.js`
- Test: `scripts/test-character-preview-store.mjs`

- [ ] **Step 1: Write failing preview lifecycle tests**

```js
const first = previews.replaceFacet({
  ownerScope: owner, sessionId, expectedPreviewVersion: 0,
  facet: "persona", revisionId: personaRevisionId,
});
assert.equal(first.previewVersion, 1);
assert.equal(first.personaRevisionId, personaRevisionId);
assert.throws(() => previews.replaceFacet({
  ownerScope: owner, sessionId, expectedPreviewVersion: 0,
  facet: "persona", revisionId: nextPersonaRevisionId,
}), /CHARACTER_PREVIEW_CONFLICT/);
assert.equal(reopenStore().get(owner, sessionId).personaRevisionId, personaRevisionId);
assert.equal(previews.get(otherOwner, sessionId), null);
```

Also test character replacement, persona replacement, world-book add-or-replace by
entity ID, facet removal, no duplicate books, invalid/foreign revisions, and
activation that commits the durable facet and removes preview in one transaction.

- [ ] **Step 2: Run test and verify failure**

Run: `node scripts/test-character-preview-store.mjs`

Expected: FAIL because `CharacterPreviewStore` does not exist.

- [ ] **Step 3: Implement preview storage and composition**

```js
class CharacterPreviewStore {
  get(ownerScope, sessionId) {}
  replaceFacet({ ownerScope, sessionId, expectedPreviewVersion, facet, revisionId }) {}
  addWorldBook({ ownerScope, sessionId, expectedPreviewVersion, revisionId }) {}
  removeFacet({ ownerScope, sessionId, expectedPreviewVersion, facet, entityId }) {}
  clear({ ownerScope, sessionId, expectedPreviewVersion }) {}
  effectiveConfig({ ownerScope, sessionId, durableConfig }) {}
  activateFacet({ ownerScope, sessionId, expectedPreviewVersion, expectedBindingVersion, facet, entityId }) {}
}
```

Every write validates the exact revision and owner through the corresponding
repository. `effectiveConfig` is pure after reads: invalid preview pins are omitted
independently and replaced by the matching durable facet.

- [ ] **Step 4: Run preview and concurrency tests**

Run: `node scripts/test-character-preview-store.mjs && node scripts/test-character-worlds-concurrency-stress.mjs`

Expected: all PASS; stress output reports zero cross-owner or cross-session leaks.

- [ ] **Step 5: Commit**

```bash
git add src/main/character-worlds/preview-store.js src/main/character-worlds/repository.js scripts/test-character-preview-store.mjs
git commit -m "feat: add persistent character worlds previews"
```

## Task 4: Snapshot Effective Configuration at Turn Admission

**Files:**
- Modify: `src/main/character-worlds/turn-binding-snapshot.js`
- Modify: `src/main/character-worlds/runtime-contract.js`
- Modify: `src/main/character-worlds/runtime.js`
- Modify: `src/main/character-worlds/turn-runtime-adapter.js`
- Modify: `src/main/store/turn-input-store.js`
- Modify: `src/main/store/turn-admission-migration-metadata.js`
- Test: `scripts/test-character-worlds-runtime.mjs`
- Test: `scripts/test-character-preview-admission.mjs`

- [ ] **Step 1: Write failing admission tests**

```js
const admitted = runtime.admitTurn({
  ownerScope, sessionId, turnId,
  durableConfig: { characterRevisionId: null, personaRevisionId, books: [] },
  preview: { previewVersion: 3, worldBooks: [{ entityId, revisionId: worldRevisionId }] },
});
assert.equal(admitted.mode, "native");
assert.equal(admitted.effectiveConfig.personaRevisionId, personaRevisionId);
assert.equal(admitted.effectiveConfig.books[0].worldBookRevisionId, worldRevisionId);
assert.equal(Object.isFrozen(admitted.effectiveConfig), true);
assert.deepEqual(recovered.characterWorlds, admitted);
```

Test retries, steering, scheduled admissions, queue recovery, corrupt preview JSON,
missing preview revisions, and feature-disabled byte-equivalent native fallback.

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-preview-admission.mjs`

Expected: FAIL because snapshots require a character revision and do not persist
effective preview configuration.

- [ ] **Step 3: Evolve the snapshot contract to schema version 2**

```js
const snapshot = deepFreeze({
  schemaVersion: 2,
  mode: config.characterRevisionId ? "character" : "native",
  bindingVersion,
  previewVersion,
  effectiveConfig: normalizeConversationConfig(config),
  compatibilityProfile: config.characterRevisionId ? compatibilityProfile : null,
  snapshotStatus: "ready",
});
```

Accept v1 persisted snapshots unchanged during recovery. A v2 native snapshot may
be `ready` when persona or books are active. A fully empty/disabled configuration
must preserve the existing native dispatch bytes.

- [ ] **Step 4: Persist the exact admitted snapshot**

Serialize the normalized snapshot into `turn_inputs.character_worlds_snapshot_json`
inside the existing admission transaction. Recovery first uses this column and
never rereads current binding or preview state.

- [ ] **Step 5: Run admission and parity tests**

Run: `node scripts/test-character-preview-admission.mjs && node scripts/test-character-worlds-runtime.mjs && node scripts/test-turn-orchestrator.mjs && node scripts/test-character-agent-task-parity.mjs && node scripts/test-scheduled-task-isolation.mjs`

Expected: all PASS; disabled/empty native cases remain byte-equivalent.

- [ ] **Step 6: Commit**

```bash
git add src/main/character-worlds/turn-binding-snapshot.js src/main/character-worlds/runtime-contract.js src/main/character-worlds/runtime.js src/main/character-worlds/turn-runtime-adapter.js src/main/store/turn-input-store.js src/main/store/turn-admission-migration-metadata.js scripts/test-character-preview-admission.mjs scripts/test-character-worlds-runtime.mjs
git commit -m "feat: admit character worlds preview snapshots"
```

## Task 5: Compile Optional Facets Without a Character

**Files:**
- Modify: `src/main/character-worlds/context-compiler.js`
- Modify: `src/main/character-worlds/turn-world-book.js`
- Modify: `src/main/character-worlds/world-envelope.js`
- Modify: `src/main/character-worlds/compaction.js`
- Test: `scripts/test-character-composition-matrix.mjs`
- Test: `scripts/test-character-worlds-capability-gate.mjs`

- [ ] **Step 1: Write the failing composition matrix**

Build all nine durable combinations and preview overrides from the design spec.
For each, assert the expected character/persona/book blocks and invariant dispatch
fields:

```js
assert.deepEqual(projectCapabilities(compiled), projectCapabilities(nativeTurn));
assert.equal(compiled.model, nativeTurn.model);
assert.deepEqual(compiled.tools, nativeTurn.tools);
assert.equal(compiled.permissionMode, nativeTurn.permissionMode);
assert.equal(compiled.userText, nativeTurn.userText);
assert.ok(compiled.system.startsWith(protectedLilyPrefix));
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-composition-matrix.mjs`

Expected: FAIL for native Lily plus persona and native Lily plus world books.

- [ ] **Step 3: Compile facets independently**

Refactor the compiler entry into independently guarded blocks:

```js
const characterBlock = config.characterRevisionId
  ? compileCharacterFacet(config.characterRevisionId, context)
  : null;
const personaBlock = config.personaRevisionId
  ? compilePersonaFacet(config.personaRevisionId, context)
  : null;
const worldBlocks = config.books.length
  ? compileWorldBookFacets(config.books, context)
  : [];
return compileLowerAuthorityEnvelope({ characterBlock, personaBlock, worldBlocks, budgets });
```

Each facet catches missing/corrupt/over-budget errors separately. A failed preview
facet falls back to its durable counterpart supplied by admission; if that also
fails, only that facet is omitted in the same model dispatch.

- [ ] **Step 4: Update compaction projection**

Compaction records exact revision pins for all active facets without assuming a
character exists. It must not copy raw persona or lore text into summary metadata.

- [ ] **Step 5: Run runtime security and parity tests**

Run: `node scripts/test-character-composition-matrix.mjs && node scripts/test-character-worlds-capability-gate.mjs && node scripts/test-character-persona-context.mjs && node scripts/test-character-world-book-compile.mjs && node scripts/test-character-agent-task-parity.mjs`

Expected: all PASS with one dispatch per turn and unchanged capability projection.

- [ ] **Step 6: Commit**

```bash
git add src/main/character-worlds/context-compiler.js src/main/character-worlds/turn-world-book.js src/main/character-worlds/world-envelope.js src/main/character-worlds/compaction.js scripts/test-character-composition-matrix.mjs scripts/test-character-worlds-capability-gate.mjs
git commit -m "feat: compile independent character worlds facets"
```

## Task 6: Produce Durable Character Worlds Result Receipts

**Files:**
- Create: `src/main/character-worlds/receipt-store.js`
- Create: `src/main/character-worlds/receipt-actions.js`
- Create: `src/main/character-worlds/draft-receipt.js`
- Modify: `src/main/required-tool-completion.js`
- Modify: `src/main/turn-terminal-finalizer.js`
- Modify: `src/main/block-protocol.js`
- Test: `scripts/test-character-worlds-receipts.mjs`
- Test: `scripts/test-required-tool-completion.mjs`

- [ ] **Step 1: Write failing trusted-receipt tests**

```js
const evidence = successfulToolResult({
  name: "lily_character_draft",
  callId: "call-1",
  input: { action: "create", kind: "persona", canonical: { name: "Lead" } },
  output: { ok: true, entityId, revisionId, revisionNumber: 1 },
});
const block = receipts.createFromToolEvidence({ ownerScope, sessionId, turnId, evidence });
assert.equal(block.type, "character_worlds_receipt");
assert.equal(block.kind, "persona");
assert.equal(Object.hasOwn(block, "entityId"), false);
assert.equal(Object.hasOwn(block, "revisionId"), false);
```

Test malformed output, wrong owner, wrong kind, missing revision, revision/entity
mismatch, duplicate tool delivery, failed tool, hostile prototypes, oversized safe
summary, and a result that claims success without repository evidence.

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-worlds-receipts.mjs`

Expected: FAIL because required-tool state stores only the tool name and no trusted
successful-result evidence.

- [ ] **Step 3: Retain bounded successful tool evidence**

Extend required-tool state without changing completion semantics:

```js
return {
  required,
  successful: new Set(),
  successfulResults: new Map(),
  activeById: new Map(),
};
```

For `lily_character_draft`, retain only call ID, normalized action/kind/entity/base
input metadata, and parsed successful result. Cap the serialized evidence at 8 KiB;
never retain canonical prose in this state.

- [ ] **Step 4: Implement receipt validation and storage**

`DraftReceiptBuilder.create` rereads the exact owner-scoped revision, verifies its
entity and `agent_draft` provenance, derives display name and a bounded safe summary
from repository inspection, stores the immutable receipt, and returns:

```js
{
  id: `character-worlds-receipt:${receiptId}`,
  type: "character_worlds_receipt",
  schemaVersion: 1,
  receiptId,
  kind,
  displayName,
  summary,
  revisionNumber,
  state: "draft",
  provenance: "agent_draft",
}
```

`ReceiptActionBroker` holds at most 512 random 256-bit tokens, expires each after
15 minutes, binds it to one owner/session/receipt/action tuple, and consumes mutating
actions once. Read-only `view` tokens may be reused until expiry. Historical cards
request fresh tokens from the persisted receipt and never store tokens in messages.

- [ ] **Step 5: Attach receipt blocks before assistant commit**

In terminal finalization, create receipts only after required-tool completion has
accepted `ok: true`, append them through `buildResultBlocks({ extraBlocks })`, and
leave the turn truthful if receipt validation fails. Receipt failure must add a
coded diagnostic and must not create a success block.

- [ ] **Step 6: Run receipt, completion, and history tests**

Run: `node scripts/test-character-worlds-receipts.mjs && node scripts/test-required-tool-completion.mjs && node scripts/test-character-agent-draft.mjs && node scripts/test-session-reload.mjs`

Expected: all PASS; history replay restores the same safe result block.

- [ ] **Step 7: Commit**

```bash
git add src/main/character-worlds/receipt-store.js src/main/character-worlds/receipt-actions.js src/main/character-worlds/draft-receipt.js src/main/required-tool-completion.js src/main/turn-terminal-finalizer.js src/main/block-protocol.js scripts/test-character-worlds-receipts.mjs scripts/test-required-tool-completion.mjs
git commit -m "feat: add durable character worlds receipts"
```

## Task 7: Add Trusted Preview and Activation IPC

**Files:**
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/main/ipc-assistant.js`
- Modify: `src/preload.js`
- Modify: `src/main/ipc-handlers.js`
- Test: `scripts/test-character-worlds-experience-ipc.mjs`

- [ ] **Step 1: Write failing IPC boundary tests**

Assert untrusted sender rejection, oversized payload rejection, expired/wrong-action
token rejection, owner/session mismatch rejection, CAS conflict projection, and
successful start/exit/activate/refine-target flows.

```js
assert.deepEqual(await invoke("character-worlds:receipt-actions", { receiptId }), {
  ok: true,
  actions: {
    preview: assertToken,
    activate: assertToken,
    adjust: assertToken,
    view: assertToken,
  },
});
assert.equal((await invokeAsOtherOwner("character-worlds:preview-start", {
  actionToken,
  expectedPreviewVersion: 0,
})).error, "CHARACTER_ACTION_FORBIDDEN");
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-worlds-experience-ipc.mjs`

Expected: FAIL because the experience channels are not registered.

- [ ] **Step 3: Register allowlisted main-process actions**

Add channels:

```text
character-worlds:receipt-actions
character-worlds:preview-get
character-worlds:preview-start
character-worlds:preview-exit
character-worlds:preview-activate
character-worlds:adjust-target
```

Every channel derives owner and session authority in main. `adjust-target` returns
only an opaque authoring context handle; `ipc-assistant.js` resolves that handle to
trusted `{kind, entityId, expectedBaseRevisionId}` when the next message is sent.

- [ ] **Step 4: Expose a narrow preload API**

```js
getCharacterWorldsReceiptActions: (receiptId) => ipcRenderer.invoke(
  "character-worlds:receipt-actions", { receiptId },
),
startCharacterWorldsPreview: (payload) => ipcRenderer.invoke(
  "character-worlds:preview-start", payload,
),
activateCharacterWorldsPreview: (payload) => ipcRenderer.invoke(
  "character-worlds:preview-activate", payload,
),
```

Do not expose entity IDs, owner scope, raw canonical definitions, or direct preview
table mutation.

- [ ] **Step 5: Run IPC and preload tests**

Run: `node scripts/test-character-worlds-experience-ipc.mjs && node scripts/test-character-worlds-ipc.mjs && node scripts/test-preload-surface.mjs`

Expected: all PASS with unchanged legacy channel behavior.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-character-worlds.js src/main/ipc-handlers.js src/main/ipc-assistant.js src/preload.js scripts/test-character-worlds-experience-ipc.mjs
git commit -m "feat: expose trusted character worlds actions"
```

## Task 8: Render Result Cards and Preview Banner

**Files:**
- Create: `src/renderer/modules/character-result-card.js`
- Create: `src/renderer/modules/character-preview-banner.js`
- Modify: `src/renderer/modules/content-blocks.js`
- Modify: `src/renderer/modules/character-control-model.js`
- Modify: `src/renderer/modules/character-session-control.js`
- Modify: `src/renderer/modules/character-authoring-marker.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles/character-worlds.css`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Test: `scripts/test-character-result-card.cjs`
- Test: `scripts/test-character-preview-banner.cjs`
- Test: `scripts/test-character-session-control.cjs`

- [ ] **Step 1: Write failing pure renderer tests**

```js
const card = renderReceipt(receiptBlock, deps);
assert.equal(card.querySelector("[data-action='preview']").textContent, "试聊");
assert.equal(card.textContent.includes(receiptBlock.receiptId), false);
await click(card, "[data-action='adjust']");
assert.equal(deps.composer.marker.kind, "characterWorldsAdjustment");
assert.equal(Object.hasOwn(deps.composer.marker, "revisionId"), false);
```

Test translated character/persona/world-book labels, loading/error/conflict states,
double-click suppression, stale session responses, RTL layout, long names, preview
restore after session reload, and all banner actions.

For world-book test turns, also assert the optional activation diagnostic renders
only matched entry titles plus bounded reason codes. Raw entry bodies, system
messages, trigger internals, and protected prompt text must not enter renderer
state.

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-result-card.cjs && node scripts/test-character-preview-banner.cjs`

Expected: FAIL because typed receipt rendering and the preview banner do not exist.

- [ ] **Step 3: Implement the result-card renderer**

`renderCharacterResultCard(block, deps)` validates the safe block schema, obtains
fresh actions on demand, uses Lucide icons through the existing icon helper, and
renders facet-specific labels. Unknown/malformed blocks render a neutral unavailable
state and never fall back to raw JSON.

- [ ] **Step 4: Implement preview state and banner**

Extend pure state with:

```js
preview: {
  previewVersion: 0,
  character: null,
  persona: null,
  worldBooks: [],
  loading: false,
  conflict: null,
}
```

Session changes reset renderer projection and reload exact state from main. Banner
actions carry the session sequence and expected preview/binding versions so stale
responses cannot paint or mutate another conversation.

- [ ] **Step 5: Wire natural-language adjustment**

`Adjust` stores only the opaque authoring context handle in the composer marker and
focuses an ordinary-language prompt. The send path transfers the handle outside
editable text; main resolves it before injecting the trusted revise contract.

World-book preview notices are projected from main-owned activation metadata as a
small allowlisted block `{entryTitle, reasonCode}`. Unknown fields are dropped and
the block is omitted when no entry activates.

- [ ] **Step 6: Run renderer tests**

Run: `node scripts/test-character-result-card.cjs && node scripts/test-character-preview-banner.cjs && node scripts/test-character-session-control.cjs && node scripts/test-character-library.cjs && node scripts/test-character-authoring-marker.mjs`

Expected: all PASS with no nested cards, unstable dimensions, or ID exposure.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/modules/character-result-card.js src/renderer/modules/character-preview-banner.js src/renderer/modules/content-blocks.js src/renderer/modules/character-control-model.js src/renderer/modules/character-session-control.js src/renderer/modules/character-authoring-marker.js src/renderer/index.html src/renderer/styles/character-worlds.css src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json scripts/test-character-result-card.cjs scripts/test-character-preview-banner.cjs scripts/test-character-session-control.cjs
git commit -m "feat: add character worlds preview experience"
```

## Task 9: Close Refinement, Conflict, and Recovery Loops

**Files:**
- Modify: `src/main/ipc-assistant.js`
- Modify: `src/main/character-worlds/authoring-intent.js`
- Modify: `src/main/character-worlds/agent-draft-tools.js`
- Modify: `src/main/turn-queue-recovery-envelope.js`
- Modify: `src/main/required-tool-completion-gate.js`
- Create: `src/main/character-worlds/experience-observability.js`
- Test: `scripts/test-character-worlds-refinement-loop.mjs`
- Test: `scripts/test-character-authoring-intent.mjs`
- Test: `scripts/test-required-tool-completion.mjs`

- [ ] **Step 1: Write failing end-to-end refinement tests**

```js
const routed = resolveEngineRouting({
  text: "再独立一点",
  characterWorldsAdjustmentHandle: handle,
  sessionId,
});
assert.deepEqual(routed.requiredSuccessfulTools, ["lily_character_draft"]);
assert.match(routed.engineText, /action=revise/);
assert.doesNotMatch(routed.engineText, new RegExp(entityId));
assert.equal(recovered.requiredSuccessfulTools[0], "lily_character_draft");
```

Test preview auto-advance only when adjustment originated from that exact preview,
durable binding never auto-advances, revision conflict returns a visible refresh
path, unavailable tools terminate after bounded correction, and queue recovery
retains the required persistence contract and opaque adjustment handle.

- [ ] **Step 2: Run tests and verify failure**

Run: `node scripts/test-character-worlds-refinement-loop.mjs`

Expected: FAIL because receipt-originated trusted revise context is not routed.

- [ ] **Step 3: Resolve adjustment context in main**

Resolve the opaque handle after session authority validation and inject a protected
broker context block. The model receives the semantic instruction and tool schema;
trusted IDs are supplied to the broker tool by host context, not copied into user
text or renderer-editable markers.

Change the draft handler so a valid main-owned adjustment context overrides
model-supplied `entityId` and `expectedBaseRevisionId`. A missing, expired, or
owner/session-mismatched context rejects revise with `CHARACTER_ACTION_FORBIDDEN`;
the create path remains unchanged.

- [ ] **Step 4: Advance exact preview after successful revision**

After receipt validation, compare the preview's current entity/revision and preview
version against the adjustment origin. If all match, CAS the preview to the new
revision and mark the receipt state `previewed`. Otherwise leave both preview and
durable configuration unchanged and expose `Try`/`Use` actions normally.

Emit local structured events for draft outcome, receipt outcome, preview lifecycle,
activation outcome/conflict, and facet fallback. Event payloads contain reason
codes, timings, opaque IDs, and revision hashes only; reject chat text, canonical
content, summaries, paths, and prompt bodies at the observability helper boundary.

- [ ] **Step 5: Run recovery and required-tool tests**

Run: `node scripts/test-character-worlds-refinement-loop.mjs && node scripts/test-character-authoring-intent.mjs && node scripts/test-required-tool-completion.mjs && node scripts/test-turn-queue-recovery-envelope.mjs`

Expected: all PASS; failure ends with one explicit not-saved result and no Markdown
substitute.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-assistant.js src/main/character-worlds/authoring-intent.js src/main/character-worlds/agent-draft-tools.js src/main/turn-queue-recovery-envelope.js src/main/required-tool-completion-gate.js src/main/character-worlds/experience-observability.js scripts/test-character-worlds-refinement-loop.mjs scripts/test-character-authoring-intent.mjs scripts/test-required-tool-completion.mjs
git commit -m "feat: close character worlds refinement loop"
```

## Task 10: Register Capability Gates and Release Verification

**Files:**
- Modify: `CAPABILITY-GATE.md`
- Modify: `src/shared/capability-gates.json`
- Modify: `src/shared/architecture-boundaries.json`
- Modify: `docs/character-worlds-gap-trace.md`
- Test: `scripts/test-character-worlds-experience-gate.mjs`
- Test: all discovered Character Worlds and platform suites

- [ ] **Step 1: Add the closed-loop capability gate test**

The new gate must prove:

```js
assertNativeByteEquivalent(featureDisabledTurn, baselineTurn);
assertNativeByteEquivalent(malformedPreviewTurn, durableBaselineTurn);
assertSameCapabilities(characterTurn, baselineTurn);
assertSameCapabilities(personaOnlyTurn, baselineTurn);
assertSameCapabilities(worldBookOnlyTurn, baselineTurn);
assertNoCrossSessionLeak(concurrentResults);
assertNoCrossOwnerLeak(concurrentResults);
assertTruthfulUnsavedResult(toolUnavailableResult);
```

- [ ] **Step 2: Run the focused complete journey**

Run: `node scripts/test-character-worlds-experience-gate.mjs`

Expected: PASS for create receipt, preview, refine, activate, restart, conflict,
disabled, malformed, and two-session isolation cases.

- [ ] **Step 3: Update the machine-readable gates and architecture budgets**

Register one capability entry whose baseline is native Lily plus the existing
durable Character Worlds path, fail-open route is the exact durable/native
configuration, and guard test is `test-character-worlds-experience-gate.mjs`.
Ratchet new files under 500 lines and do not increase existing hotspot budgets.

- [ ] **Step 4: Run focused Character Worlds verification**

Run:

```bash
node scripts/test-character-worlds-experience-gate.mjs
node scripts/test-character-worlds-concurrency-stress.mjs
node scripts/test-character-card-fuzz.mjs
node scripts/test-character-worlds-performance.mjs
node scripts/test-character-agent-task-parity.mjs
node scripts/test-character-library.cjs
```

Expected: all PASS with no skipped deterministic scenario.

- [ ] **Step 5: Run platform gates and full suite**

Run:

```bash
npm run test:capability-gate
npm run test:unit
```

Expected: capability gate and every auto-discovered test PASS. Record exact totals
from command output; do not reuse earlier totals.

- [ ] **Step 6: Run packaged application smoke tests**

Fully restart Electron with `npm start`, then verify on the local packaged-capable
runtime:

1. Create, preview, refine, and activate one character.
2. Use a persona with native Lily.
3. Add and trigger a world book with native Lily.
4. Combine all three, switch conversations during a turn, and restart the app.
5. Confirm tools, files, permissions, scheduled messages, and ordinary Lily answers
   remain available.

Expected: no raw IDs, no Markdown fake entity, no cross-conversation state, and
preview restoration after restart. Windows packaged smoke remains explicitly open
until run on Windows hardware or CI.

- [ ] **Step 7: Update verified documentation and commit**

```bash
git add CAPABILITY-GATE.md src/shared/capability-gates.json src/shared/architecture-boundaries.json docs/character-worlds-gap-trace.md scripts/test-character-worlds-experience-gate.mjs
git commit -m "test: gate unified character worlds experience"
```

## Completion Rule

Do not mark this plan complete while any deterministic test is failing, any result
card can be produced without a verified durable receipt, persona/world-book use
still requires a character, preview state can cross owner/session scope, activation
and preview removal are not one transaction, or a feature failure changes the
native model/tool/file/permission surface. Unavailable Windows evidence is reported
as an explicit release-validation gap rather than silently treated as complete.
