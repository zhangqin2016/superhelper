# Lily Character Worlds Native Compatibility Design

Date: 2026-07-29
Status: Proposed for user review

## 1. Purpose

Add a native character and world experience to Lily Workbench that can consume
the mainstream SillyTavern character-card ecosystem without embedding or
forking SillyTavern.

The feature must let a user:

- Keep using Lily's original voice with no character selected.
- Select a character independently for each conversation.
- Import, create, edit, version, export, and reuse character cards.
- Use personas, world books, group scenes, and long-running role conversations.
- Change the selected character during an existing conversation without
  rewriting or branching its history.
- Continue using Lily's complete Agent, files, skills, tools, permissions,
  evidence, memory, and subagent capabilities.

The central product rule is:

> Character Worlds changes how Lily participates in a conversation. It does not
> replace the Lily execution kernel or reduce its capabilities.

## 2. Confirmed Product Decisions

1. Lily implements a native compatibility layer and native workbench. It does
   not embed SillyTavern as a web application.
2. Character selection is optional and scoped to one conversation.
3. No selection means the exact current Lily baseline.
4. Different conversations can use different characters, personas, and worlds
   concurrently without sharing mutable state.
5. Changing a character in a long conversation takes effect on the next turn.
   Existing history remains unchanged and remains available as conversational
   history.
6. Persona describes the user's narrative identity only. It never changes the
   real account identity, project scope, file access, tool permissions, or
   security policy.
7. Declarative ecosystem data is supported. Imported executable extensions,
   plugins, scripts, macros, remote code, and automation are never executed.
8. A malformed, missing, incompatible, or failed character feature must fall
   back to Lily's current behavior rather than failing the user turn.

## 3. Non-Goals

- Running SillyTavern UI extensions or server plugins.
- Reproducing the entire SillyTavern interface.
- Replacing Lily's system prompt, Turn Orchestrator, OpenCode runtime, tools,
  skills, evidence gates, permissions, or task memory.
- Giving a card author authority to select models, invoke tools, modify files,
  install dependencies, send network requests, or change application settings.
- Treating a fictional Persona as an authenticated Lily user.
- Automatically downloading remote card assets or executing content referenced
  by URLs.
- Guaranteeing behavioral parity for undocumented vendor-specific executable
  extensions.

## 4. Compatibility Boundary

### 4.1 Supported data

The first compatibility contract covers:

- Character Card V2 JSON.
- Character Card V2 data embedded in PNG cards.
- V2 character books/lore books embedded in a card.
- Standalone world/lore book JSON where it can be normalized without guessing.
- Persona records containing a name, description, and optional local avatar.
- Multiple greetings and alternate greetings.
- Common declarative metadata and unknown extension fields.

Lily stores the original imported payload so a card can be exported without
silently discarding fields that Lily does not understand. Unknown fields are
preserved as inert data and are never converted into executable behavior.

### 4.2 Unsupported behavior

The following may be preserved for round-trip fidelity but remain disabled:

- JavaScript or other executable code.
- SillyTavern UI extensions.
- SillyTavern server plugins.
- Macros with side effects.
- Tool or function declarations that attempt to bypass Lily's tool broker.
- Remote asset loaders, webhooks, and external API calls.
- Host-setting overrides, model overrides, and permission overrides.

The import result reports unsupported inert fields without blocking use of the
safe parts of the card.

### 4.3 Licensing strategy

Implementation is clean-room and based on public data-format behavior and
documentation. Lily must not copy SillyTavern AGPL source or ship its UI,
extensions, or server plugin runtime unless a separate legal decision accepts
the resulting obligations.

Reference documentation:

- [SillyTavern repository](https://github.com/SillyTavern/SillyTavern)
- [Characters](https://docs.sillytavern.app/usage/characters/)
- [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [UI extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [Server plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)

## 5. Architecture

Lily uses two planes over one execution kernel.

```text
Experience plane
  Character Library
  Persona Library
  World Books
  Scene / Group State
  Character Revision Binding
          |
          v
Character Context Compiler
  schema validation
  activation and retrieval
  authority labeling
  token budgeting
  provenance
          |
          v
Lily control plane (unchanged authority)
  Turn Orchestrator
  Lily system identity and policies
  OpenCode Agent runtime
  tools / skills / files / permissions
  evidence and delivery gates
  session memory and compaction
```

Character Worlds is a bounded context producer. It is not a second agent
runtime, a prompt replacement, or an output-rewriting proxy.

### 5.1 Component boundaries

`CharacterAssetStore`

- Owns imported originals, canonical normalized records, revisions, local
  assets, hashes, provenance, and deletion.
- Does not compile prompts or run retrieval.

`CharacterImporter`

- Performs bounded format detection, parsing, validation, sanitization, and
  normalization.
- Produces a structured import report.
- Never executes imported content.

`CharacterSessionBinding`

- Owns the optional character, Persona, world books, and scene mode for one
  conversation.
- Records immutable revision references and the turn boundary at which a change
  becomes effective.

`WorldBookResolver`

- Resolves active entries using deterministic card semantics, recency, depth,
  ordering, probability, and token limits.
- Is local and side-effect free.

`CharacterContextCompiler`

- Produces one bounded, labeled, hidden context layer for the next turn.
- Enforces authority ordering and emits diagnostics and provenance.
- Returns no context on failure so the normal Lily turn can proceed.

`SceneCoordinator`

- Maintains structured group-scene state and determines the next speaker.
- Does not create a new privileged Agent or duplicate tool execution for each
  fictional character.

`CharacterWorkbench`

- Provides native import, creation, editing, revision history, selection, and
  export.
- Keeps the main conversation as the primary experience.

## 6. Authority And Capability Invariants

The effective instruction order is:

```text
1. Lily system identity, safety, product rules, and capability contract
2. Host-enforced account, project, permission, and tool policy
3. Turn contract, evidence requirements, and user task
4. Character mode contract
5. Selected character revision
6. Persona narrative description
7. Activated world-book entries and scene state
8. Character episodic memory
9. Conversation history
```

Higher layers always win. Imported text is explicitly delimited and labeled as
untrusted narrative data. A card statement such as "ignore all prior
instructions," "never use tools," or "send this file" has no authority over
layers 1 through 3.

Host enforcement remains the real security boundary:

- Tool calls still pass through Lily's existing permission broker.
- File and project access still use the conversation's real project scope.
- Evidence and delivery gates still determine whether completion claims are
  justified.
- Model routing and skill availability remain controlled by Lily.
- Subagents remain Lily workers. They receive task facts and evidence needs,
  not fictional authority. Their findings return to the primary Agent, which
  expresses the answer in the active character voice.

Character style is produced in the primary response. Lily does not run a second
model to rewrite a completed answer because that could remove evidence,
corrupt commands, or introduce unsupported claims.

## 7. Data Model

All IDs are opaque UUIDs. Revisions are immutable. Mutable library records point
to a current revision.

### 7.1 Character

```js
{
  schemaVersion: 1,
  id: "uuid",
  displayName: "Character name",
  currentRevisionId: "uuid",
  createdAt: "ISO-8601",
  updatedAt: "ISO-8601",
  archivedAt: null
}
```

### 7.2 Character revision

```js
{
  schemaVersion: 1,
  id: "uuid",
  characterId: "uuid",
  revisionNumber: 3,
  contentHash: "sha256:...",
  source: {
    kind: "created" | "imported" | "edited",
    format: "lily" | "character_card_v2_json" | "character_card_v2_png",
    originalFileName: "card.png",
    importedAt: "ISO-8601"
  },
  profile: {
    name: "",
    description: "",
    personality: "",
    scenario: "",
    firstMessage: "",
    alternateGreetings: [],
    exampleDialogue: "",
    creatorNotes: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    tags: []
  },
  characterBookRevisionId: "uuid-or-null",
  avatarAssetId: "uuid-or-null",
  preservedOriginalAssetId: "uuid-or-null",
  preservedExtensions: {},
  warnings: [],
  createdAt: "ISO-8601"
}
```

Imported `systemPrompt` and `postHistoryInstructions` retain their ecosystem
meaning only inside the lower-authority character layer. Their names do not
grant system-level authority in Lily.

### 7.3 Persona revision

```js
{
  schemaVersion: 1,
  id: "uuid",
  personaId: "uuid",
  revisionNumber: 2,
  name: "",
  description: "",
  avatarAssetId: "uuid-or-null",
  contentHash: "sha256:...",
  createdAt: "ISO-8601"
}
```

Persona is narrative context only. It has no account or authorization fields.

### 7.4 World book revision

```js
{
  schemaVersion: 1,
  id: "uuid",
  worldBookId: "uuid",
  revisionNumber: 4,
  name: "",
  entries: [{
    id: "stable-entry-id",
    enabled: true,
    primaryKeys: [],
    secondaryKeys: [],
    selective: false,
    constant: false,
    content: "",
    position: "before_character" | "after_character" | "before_examples" |
      "after_examples" | "at_depth",
    depth: 4,
    order: 100,
    probability: 100,
    caseSensitive: false,
    matchWholeWords: false,
    preservedExtensions: {}
  }],
  contentHash: "sha256:...",
  createdAt: "ISO-8601"
}
```

### 7.5 Conversation binding

```js
{
  schemaVersion: 1,
  bindingVersion: 7,
  mode: "native" | "character" | "group" | "story",
  activeCharacterRevisionId: "uuid-or-null",
  activePersonaRevisionId: "uuid-or-null",
  worldBookRevisionIds: [],
  groupSceneId: "uuid-or-null",
  effectiveAfterTurnId: "last-admitted-turn-id-or-null",
  updatedAt: "ISO-8601"
}
```

`mode: "native"` with empty revision references is the Lily baseline.

`effectiveAfterTurnId` describes an admission boundary that already exists; it
does not invent the ID of a future turn. Every admitted turn records the exact
`bindingVersion` and revision IDs it actually used, which is the authoritative
answer to "when did this binding first apply?"

The session index stores only the binding and small display metadata. Canonical
character data and assets live in a dedicated local store so copying session
indexes does not duplicate large images or imported originals.

### 7.6 Binding event

Every change also creates an append-only event:

```js
{
  schemaVersion: 1,
  id: "uuid",
  sessionId: "uuid",
  type: "character_binding.changed",
  previousBinding: {},
  nextBinding: {},
  effectiveAfterTurnId: "last-admitted-turn-id-or-null",
  createdAt: "ISO-8601"
}
```

This event is visible as a lightweight conversation marker, not as a fabricated
user or assistant message.

## 8. Character Switching Semantics

Changing a character in an existing conversation does not create a branch and
does not mutate historical messages.

1. The user selects a new character or returns to native Lily.
2. Lily writes a new immutable binding version and change event, bounded after
   the latest already admitted turn.
3. The new binding becomes effective when the next user turn is admitted.
4. The next turn compiles only the newly active character as current
   instructions.
5. Historical messages remain normal conversational evidence and can mention
   the previous character, but the previous card is no longer injected as an
   active instruction.
6. Every archived turn records the effective binding revision IDs used for that
   turn.

If a switch happens while a turn is running, the running turn keeps its admitted
snapshot. The new binding starts with the following turn. This prevents
mid-stream identity changes and race conditions.

Deleting or editing a library item cannot silently change an old or in-flight
conversation. Bound revision snapshots remain readable until no conversation or
turn references them.

## 9. Turn Data Flow

```text
User sends message
  -> Turn Orchestrator admits exact conversation + turn
  -> Snapshot current CharacterSessionBinding
  -> Resolve referenced immutable revisions
  -> Activate bounded world-book entries
  -> Load bounded scene and character memory
  -> Compile labeled CharacterContext
  -> Apply global context budget
  -> Dispatch one normal Lily/OpenCode turn
  -> Tools and subagents run under existing Lily controls
  -> Archive answer, evidence, and effective binding provenance
  -> Update scene/episodic memory only after successful finalization
```

The binding snapshot belongs to the admitted turn, not the currently visible UI
conversation. Concurrent conversations therefore cannot read each other's
character state.

Scheduled tasks inherit the binding of their exact target conversation at turn
admission. They never use the character selected in the currently focused
window. A queued scheduled turn uses the binding effective when it is admitted,
matching normal queued-message semantics.

## 10. Context Compilation And Budgeting

### 10.1 Compiled contract

The compiler returns structured output:

```js
{
  schemaVersion: 1,
  text: "bounded hidden context",
  fingerprint: "sha256:...",
  effectiveBinding: {},
  activatedWorldEntries: [{
    worldBookRevisionId: "uuid",
    entryId: "id",
    reason: "constant | primary_key | selective_match",
    contentHash: "sha256:..."
  }],
  tokenEstimate: 2400,
  omitted: [{
    source: "world_entry",
    id: "id",
    reason: "budget"
  }],
  warnings: []
}
```

Empty or failed output means "run native Lily."

### 10.2 Budget priority

Character context consumes a bounded portion of the existing per-turn input
budget. It may never crowd out Lily's system rules, current user request,
tool/evidence context, required file context, or output reserve.

Within the character allocation, keep content in this order:

1. Character identity and essential behavior.
2. Current scene state.
3. Persona narrative identity.
4. Constant world entries.
5. Triggered world entries by position and order.
6. Recent character episodic memory.
7. Examples and creator notes.

Lower-priority content is omitted with diagnostics. It is not silently
truncated in the middle of a field. Exact allocations are derived from the
model's known context window through the existing context budget manager, with
conservative defaults when model metadata is unavailable.

### 10.3 World-book activation

Activation is deterministic and reproducible:

- Inspect only a bounded recent conversation window plus the current user turn.
- Apply enabled/constant status, primary keys, optional secondary-key rules,
  case and whole-word behavior, probability, ordering, placement, recursion,
  and depth using normalized data.
- Seed probability decisions from session, turn, and entry IDs so retries of
  the same turn activate the same entries.
- Deduplicate identical content by normalized hash.
- Stop recursion and scanning at explicit depth, entry-count, character-count,
  and token limits.

An optional local semantic retrieval enhancement may add candidates when an
already available Lily index supports it. Deterministic card behavior remains
the baseline; missing embeddings or an unavailable optional dependency never
blocks the turn.

### 10.4 Long-session compaction

Compaction summaries record factual conversation state and character-switch
events, but do not promote old card instructions into permanent Lily policy.
After compaction, the current immutable binding is recompiled independently for
each turn.

The summary distinguishes:

- Real task and file facts.
- Narrative scene facts.
- Which character was active during a historical segment.
- The current active binding.

This avoids resurrecting an old role after a later switch.

## 11. Memory Model

Memory is separated by authority and purpose:

1. `Lily task memory`: authoritative work facts, files, decisions, and evidence.
2. `Conversation history`: canonical user and assistant messages.
3. `Scene state`: structured fictional location, participants, goals, and state.
4. `Character episodic memory`: bounded role-specific narrative recollections.
5. `World knowledge`: immutable activated lore from world-book revisions.
6. `Persona`: the user's selected narrative description.

Narrative memory cannot overwrite real file contents, tool results, account
facts, project identity, permissions, or evidence. Contradictions are preserved
as narrative disagreement rather than written into Lily task memory as truth.

Character episodic memory is keyed by conversation ID and character revision
ID. It is not shared across conversations unless the user explicitly exports
and imports it. Returning to a previously used character in the same
conversation can recover that character's bounded episodic memory.

Memory extraction runs only after a successful finalized turn. A failed,
cancelled, rewound, or interrupted turn does not advance scene or character
memory. Rewind restores the binding and memory checkpoint associated with the
retained turn boundary.

## 12. Group And Story Modes

A group scene contains immutable participant revision references and mutable
scene state.

```js
{
  schemaVersion: 1,
  id: "uuid",
  sessionId: "uuid",
  participantCharacterRevisionIds: [],
  activeSpeakerRevisionId: "uuid-or-null",
  speakerPolicy: "automatic" | "manual",
  sceneState: {},
  updatedAt: "ISO-8601"
}
```

In automatic mode, the primary Lily Agent selects the relevant speaker or
speakers from a bounded participant summary. In manual mode, the user chooses
the speaker. Speaker selection affects expression, not tool authority.

One user turn remains one Lily turn:

- The primary Agent may render multiple clearly labeled character voices.
- Tool work is planned and executed once through Lily's normal control plane.
- Fictional participants do not each spawn an autonomous privileged Agent.
- Subagents may still be used for real research or work under Lily's existing
  depth, evidence, and permission constraints.

This avoids multiplied costs, duplicate side effects, conflicting file edits,
and loss of evidence while preserving group interaction.

## 13. Native Workbench Experience

### 13.1 Conversation surface

The conversation header exposes one compact character control:

- Lily original voice when no character is selected.
- Current character avatar and name when selected.
- Persona and world indicators only when active.
- A clear command to switch, edit, or return to Lily.

The selector is optional and never blocks composing a normal message. Role
changes appear as lightweight timeline markers. Historical messages retain
their original presentation and do not visually change when the active card
changes.

### 13.2 Character library

The native library supports:

- Search and tag filtering.
- Import by file picker, drag-and-drop, paste, or local path.
- Card preview before activation.
- Create from a blank card or natural-language request.
- Edit fields with explicit revision creation.
- Revision history and restore-as-new-revision.
- Duplicate, archive, delete, and export.
- Import report showing preserved and unsupported inert fields.

Character creation remains natural-language friendly: the user can ask Lily to
create or revise a character, and Lily writes a draft through the same validated
domain API used by the editor. The user sees and approves the resulting card
before it becomes active.

### 13.3 Import interaction

Recognized card files offer `Import and select`, `Import only`, or `Attach as
ordinary file`. Ambiguous or unrecognized files continue through Lily's
universal local-file analysis path. Character detection must never steal an
ordinary attachment.

## 14. Import, Storage, And Security

### 14.1 Bounded parsing

All parsing occurs in the main process or a constrained local worker with:

- Explicit maximum input bytes.
- PNG dimension, chunk-size, and decoded-payload limits.
- JSON byte, nesting-depth, string-length, array-length, and entry-count limits.
- Archive entry-count, expanded-byte, compression-ratio, path-traversal, and
  symlink guards when importing a supported package.
- MIME/signature inspection instead of trusting extensions.
- No network access and no code execution.
- Cancellation and bounded elapsed time.

Oversized data is rejected as a character import with a precise reason but
remains eligible for Lily's ordinary local-file handling.

### 14.2 Canonical storage

Use content-addressed local assets and atomic metadata writes:

```text
character-worlds/
  index.json
  characters/<character-id>.json
  personas/<persona-id>.json
  world-books/<world-book-id>.json
  scenes/<scene-id>.json
  revisions/<revision-id>.json
  assets/sha256/<hash>
  originals/sha256/<hash>
```

The store uses temp-file plus rename, keeps a rolling index backup, validates
references on load, quarantines corrupt metadata, and never replaces a readable
store with an empty one after a parse failure. Content hashes provide
deduplication and integrity checks.

### 14.3 Assets and privacy

- Avatars and originals stay local by default.
- Remote URLs are text metadata until the user explicitly requests retrieval.
- Export excludes conversation history and episodic memory unless the user
  explicitly includes them.
- Imported creator metadata is displayed as card data, not trusted identity.
- Telemetry contains only coarse format, success/failure code, and bounded
  counts. It never includes card text, Persona text, world content, or images.

## 15. IPC And Domain API

Renderer code does not read or mutate character files directly. A narrow
preload bridge exposes validated commands:

```text
character:list
character:get
character:import-preview
character:import-commit
character:create
character:create-revision
character:archive
character:export

persona:list
persona:create
persona:create-revision

world-book:list
world-book:create
world-book:create-revision

session-character:get-binding
session-character:set-binding
session-character:get-events

scene:get
scene:update
```

Every mutation validates IDs and payloads in the main process. The renderer
cannot provide account IDs, project authority, tool policies, or arbitrary
filesystem output paths as trusted values.

## 16. Failure Handling And Capability Gate

The default response to a Character Worlds failure is a normal Lily turn.

| Failure | Required behavior |
|---|---|
| No character selected | Exact Lily baseline; no character context built |
| Missing/corrupt bound revision | Warn once, mark binding degraded, run native Lily |
| Import parse failure | Keep original file untouched; offer ordinary attachment analysis |
| Unsupported fields | Preserve inert data, report it, use supported card fields |
| World resolver failure | Use character without world entries |
| Character memory failure | Continue without episodic memory |
| Context compiler failure | Dispatch the original turn with native Lily |
| Context over budget | Drop lower-priority character content; never core Lily context |
| Scene coordinator failure | Fall back to selected primary character, then native Lily |
| Optional semantic index unavailable | Use deterministic world-book matching |
| Character deleted during a turn | Finish with the admitted immutable revision |
| App restart during a switch | Recover the committed binding event atomically |
| Concurrent session activity | Resolve binding only by exact admitted session ID |
| Rewind | Restore binding/memory checkpoint at retained turn boundary |

Fallback is observable in diagnostics and archives, but it must not replace the
answer with an internal error report or silently abort the turn.

A kill switch disables compilation and returns all conversations to native Lily
without deleting character data or bindings.

## 17. Concurrency And Isolation

The following keys are mandatory:

- Library assets: global local profile + immutable revision ID.
- Binding: exact Lily conversation ID.
- Turn snapshot: exact conversation ID + Lily turn ID.
- Scene state: exact conversation ID + scene ID.
- Episodic memory: exact conversation ID + character revision ID.
- Compiler cache: binding fingerprint + turn-context fingerprint.

No mutable `currentCharacter` singleton is allowed in main or renderer code.
The currently focused UI conversation is never an authority source for a turn.
Runner reuse must not reuse character context because character context is
compiled and sent per admitted request.

Concurrent turns in different conversations may compile and run in parallel.
Turns in the same conversation retain the existing admission and queue order.
All caches are immutable-value caches or scoped by the keys above.

## 18. Migration And Rollout

### Phase 1: Safe foundation

- Canonical schemas, asset store, validation, revisioning, and import reports.
- Character Card V2 PNG/JSON import and export.
- Optional single-character session binding.
- Per-turn context compiler and Capability Gate fallback.
- Lily original voice remains the default.

### Phase 2: Native authoring

- Character, Persona, and world-book creation/editing.
- Natural-language draft creation through validated domain APIs.
- Revision history, restore, archive, and library management.
- Character switching timeline events.

### Phase 3: Depth

- Full deterministic world-book activation semantics.
- Scene state and per-character episodic memory.
- Group/story modes.
- Optional local semantic retrieval enhancement.

Each phase must be independently releasable, preserve stored data for later
phases, and pass the native-Lily fallback tests before being enabled.

This document is the authoritative program design. Delivery planning is split
into one implementation plan per phase so each plan remains reviewable and
verifiable. Phase releases are capability-complete for their stated scope, but
the product integration is not declared fully complete until all acceptance
criteria in this document pass.

Existing sessions receive `mode: "native"` logically without an eager rewrite.
The binding is persisted only after the user first changes it. This avoids
mass metadata churn and makes downgrade straightforward.

## 19. Verification Strategy

### 19.1 Parser and compatibility fixtures

- Valid Character Card V2 JSON.
- Valid V2 PNG with embedded data.
- Unicode and multilingual cards.
- Multiple greetings and embedded character books.
- Unknown extension fields round-trip unchanged.
- Truncated PNG, invalid base64, malformed JSON, excessive nesting, oversized
  strings, duplicate IDs, and hostile archive paths.
- A corpus of real-world cards whose licenses permit test inclusion, plus
  synthetic edge cases for every limit.

### 19.2 Authority tests

- A card cannot override Lily identity or system rules.
- A card cannot change model, tool, skill, permission, project, or account.
- A card asking Lily to ignore evidence cannot bypass evidence gates.
- Persona cannot become an authenticated user.
- Imported scripts and plugins are never executed.
- Subagents retain Lily worker rules and depth limits.

### 19.3 Capability tests

For the same ordinary task, compare native mode with:

- Character subsystem disabled.
- No character selected.
- Missing character revision.
- Malformed character data.
- World resolver exception.
- Context compiler exception.
- Character context over budget.

All cases must preserve the native Lily task path, files, tools, evidence, and
finalization. Add this new regression vector to `CAPABILITY-GATE.md`.

### 19.4 Session and concurrency tests

- Two conversations use different characters concurrently.
- One conversation is native while another uses a role.
- Switching during a running turn affects only the following turn.
- Switching never rewrites historical messages.
- Revision edits do not mutate bound old turns.
- Scheduled work uses its target conversation, not the focused conversation.
- Restart, queue recovery, compaction, rewind, deletion, and archive restore
  preserve exact binding boundaries.
- Group scenes never duplicate side-effecting tool calls.

### 19.5 Budget and memory tests

- Core Lily context always outranks all character content.
- World entries activate deterministically on retry.
- Recursive activation terminates within limits.
- Trimming occurs by whole low-priority items.
- Compaction remembers switches without promoting old role instructions.
- Narrative memory cannot overwrite task evidence.

### 19.6 End-to-end release acceptance

Run a natural-language acceptance pack that verifies:

1. Complete a file-and-tool task in native Lily.
2. Select a role and complete the same task with role-appropriate expression.
3. Switch roles mid-conversation and verify next-turn-only behavior.
4. Return to Lily original voice and verify baseline behavior.
5. Import/export a multilingual V2 PNG and JSON with stable round trip.
6. Activate Persona and world-book entries.
7. Run two differently bound conversations concurrently.
8. Trigger parser, resolver, and compiler faults and verify native fallback.
9. Restart, compact, rewind, and resume without binding or memory bleed.
10. Verify no imported code, URL, plugin, or macro executes.

## 20. Observability

Each archived turn records bounded metadata:

```js
{
  characterWorlds: {
    enabled: true,
    mode: "character",
    characterRevisionId: "uuid",
    personaRevisionId: "uuid-or-null",
    worldBookRevisionIds: [],
    sceneId: null,
    contextFingerprint: "sha256:...",
    activatedEntryCount: 4,
    omittedEntryCount: 2,
    tokenEstimate: 2400,
    fallback: null,
    warnings: []
  }
}
```

Diagnostics expose activation reasons and omissions without logging private
content. User-facing errors remain concise. Developer diagnostics can identify
the exact session, turn, revision, compiler stage, and fallback reason.

## 21. Acceptance Criteria

The design is complete when implementation can prove all of the following:

- An empty binding is behaviorally equivalent to Lily before this feature.
- Character selection is optional, conversation-scoped, revision-pinned, and
  safe under concurrent activity.
- A role switch affects the next admitted turn and never rewrites history.
- Character data changes voice and narrative context without reducing Agent
  capability or bypassing host controls.
- Persona is strictly narrative.
- Character Card V2 PNG/JSON and supported world-book data import safely and
  preserve unknown fields inertly.
- Imported executable behavior never runs.
- World activation and context trimming are deterministic, bounded, and
  inspectable.
- Long-session compaction, scheduled turns, restart recovery, rewind, and
  deletion preserve isolation and correct binding history.
- Every subsystem failure degrades to current Lily behavior.
- Automated regression tests guard the feature in `CAPABILITY-GATE.md`.

## 22. Decision Summary

The approved direction is a Lily-native Character Worlds capability, not a
SillyTavern embed. Compatibility is at the declarative data boundary. Lily
remains the sole Agent kernel and authority owner.

This produces the desired combination: users can bring any safe standard role
card into an individual conversation, or select nothing and use Lily's original
voice, while Lily retains its full ability to reason, use tools, operate on
files, coordinate subagents, verify work, and recover from failures.
