# Lily Character Worlds Native Compatibility Design

Date: 2026-07-29
Status: Revised after architecture review; proposed for user review

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

The compatibility contract is versioned and covers:

- Legacy Character Card V1 JSON and PNG as an import-only migration format.
- Character Card V2 JSON and data embedded in PNG cards.
- Character Card V3 JSON and data embedded in PNG/APNG cards.
- Character books/lore books embedded in V2 and V3 cards.
- Standalone world/lore book JSON where it can be normalized without guessing.
- Persona records containing a name, description, and optional local avatar.
- Multiple greetings and alternate greetings.
- Common declarative metadata and unknown extension fields.

The importer detects the declared specification and embedded chunk signature;
it does not infer a newer version merely because some fields happen to exist.
When a file contains both legacy and newer embedded payloads, the newer valid
payload wins and the import report records the choice. A future declared
version is preserved but not silently interpreted as a known version.

Lily stores the original imported payload so a card can be exported without
silently discarding fields that Lily does not understand. Unknown fields are
preserved as inert data and are never converted into executable behavior.

Compatibility is reported per feature rather than as a vague success flag:

```js
{
  detectedSpec: "v1" | "v2" | "v3" | "unknown",
  container: "json" | "png" | "apng",
  imported: [],
  preservedInert: [],
  unsupported: [],
  conflicts: [],
  warnings: []
}
```

Lily distinguishes three compatibility levels:

1. `lossless_data`: the original bytes and unknown fields can be preserved.
2. `safe_behavior`: Lily implements the declarative behavior under Lily's
   authority, budget, and security model.
3. `preserved_inert`: the data survives export but does not execute.

Import success never implies complete SillyTavern runtime parity. The preview
shows the level for prompts, macros, world entries, assets, and extensions.
This is especially important for V3 cards that are structurally importable
before every safe declarative V3 behavior ships.

An unchanged import can be exported byte-for-byte from its preserved original.
After a Lily edit, export creates a valid target-version card, merges preserved
unknown fields when they do not conflict, and reports every field that cannot
round-trip. It never claims byte stability after a semantic edit.

The default edited export keeps the detected specification version. New Lily
cards export as V3. Upgrading or downgrading the target version is an explicit
choice with a pre-export loss report; Lily never silently downgrades a card for
another frontend.

### 4.2 Unsupported behavior

The following may be preserved for round-trip fidelity but remain disabled:

- JavaScript or other executable code.
- SillyTavern UI extensions.
- SillyTavern server plugins.
- Macros with side effects.
- Tool or function declarations that attempt to bypass Lily's tool broker.
- Remote asset loaders, webhooks, and external API calls.
- Host-setting overrides, model overrides, and permission overrides.
- Sampling presets, temperature, context size, model locks, and provider
  profiles. A safe presentation hint such as talkativeness may influence
  response length inside Lily's existing output budget, but it never changes
  the selected model or generation safety settings.

The import result reports unsupported inert fields without blocking use of the
safe parts of the card.

### 4.3 Safe macro compatibility

Character cards depend on template macros. Lily provides a small, pure,
versioned macro engine rather than performing ad hoc string replacement.

Initial safe macros include the character name, Persona name, current
conversation-local date/time, and explicitly supported deterministic text
macros such as `{{char}}` and `{{user}}`. Expansion is:

- allowlisted;
- bounded by input, output, nesting, and invocation counts;
- deterministic for a given session and turn where randomness is supported;
- HTML-neutral text, never code;
- performed only after activation and before token estimation;
- recorded in diagnostics without logging private expanded content.

Unknown macros remain literal and produce a compatibility warning. Macros that
read files, environment variables, credentials, clipboard data, network
resources, application state, or execute commands are unsupported and inert.
Regular-expression substitutions, scripts, STscript, and Quick Replies are not
macro features and are never executed.

### 4.4 Licensing strategy

Implementation is clean-room and based on public data-format behavior and
documentation. Lily must not copy SillyTavern AGPL source or ship its UI,
extensions, or server plugin runtime unless a separate legal decision accepts
the resulting obligations.

Reference documentation:

- [SillyTavern repository](https://github.com/SillyTavern/SillyTavern)
- [Characters](https://docs.sillytavern.app/usage/characters/)
- [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [Character Card V3 specification](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)
- [UI extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [Server plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)

No AGPL parser or card-reader dependency is adopted merely to accelerate
implementation. Any third-party dependency requires a compatible license,
maintained provenance, a supply-chain review, and the same hostile-fixture
tests as Lily's own parser.

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

- Resolves safe declarative entries using version-specific matching, recursion,
  inclusion groups, timed effects, ordering, probability, and token limits.
- Is local and side-effect free.

`CharacterMacroEngine`

- Expands only supported pure macros under deterministic limits.
- Has no filesystem, network, process, credential, or application-setting
  access.

`CharacterContextCompiler`

- Produces one bounded, labeled, hidden context layer for the next turn.
- Enforces authority ordering and emits diagnostics and provenance.
- Returns no context on failure so the normal Lily turn can proceed.

`CharacterCapabilityPolicy`

- Separates task execution from character expression.
- Prevents character data from suppressing tools, evidence gathering,
  structured output, exact text, or requested file operations.
- Chooses how strongly character voice applies to conversational prose while
  leaving machine-readable and user-authored artifacts untouched.

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

This hierarchy is a model contract, not a security sandbox. Lily never relies
on prompt wording alone to protect files, accounts, permissions, credentials,
network access, or side effects. Those remain host-enforced. Adversarial-model
tests measure instruction-following quality, but failure of such a test cannot
be used to weaken the host boundary.

Host enforcement remains the real security boundary:

- Tool calls still pass through Lily's existing permission broker.
- File and project access still use the conversation's real project scope.
- Task classification, grounding, and tool intent are derived from the original
  user request and host context before character content is attached. Imported
  text cannot manufacture a user request for file, network, or tool access.
- Evidence and delivery gates still determine whether completion claims are
  justified.
- Model routing and skill availability remain controlled by Lily.
- Subagents remain Lily workers. They receive task facts and evidence needs,
  not fictional authority. Their findings return to the primary Agent, which
  expresses the answer in the active character voice.

Character style is produced in the primary response. Lily does not run a second
model to rewrite a completed answer because that could remove evidence,
corrupt commands, or introduce unsupported claims.

### 6.1 Task integrity and expression boundary

Character instructions apply to identity, dialogue, narrative choices, and
conversational tone. They do not alter:

- source code, patches, shell commands, JSON, CSV, formulas, or schemas;
- exact quotations, citations, evidence, measured values, or error messages;
- file names, paths, document facts, or tool inputs;
- the user's requested output format;
- whether a task needs tools, files, research, verification, or subagents.

For an ordinary roleplay turn, the character can shape the whole natural
language response. For an Agent task, Lily first satisfies the real task
contract and evidence requirements; character voice applies only to safe
prose around the result. For a machine-readable answer, the requested machine
format wins and character voice is omitted unless the user explicitly asks for
role text in a defined field.

This is enforced by both prompt authority and host gates. If a task contract
requires grounding or verification and the role-influenced attempt produces no
required evidence, the existing evidence/recovery path continues the task.
Role activation is never accepted as a reason to downgrade rigor.

## 7. Data Model

All IDs are opaque UUIDs. Revisions are immutable. Mutable library records point
to a current revision. Character, Persona, world-book, and scene entities all
carry the same immutable host-derived `ownerScope`; it is shown once in the
examples rather than repeated in every envelope.

### 7.1 Character

```js
{
  schemaVersion: 1,
  id: "uuid",
  ownerScope: "host-derived-scope",
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
    format: "lily" | "character_card_v1" | "character_card_v2" |
      "character_card_v3",
    container: "json" | "png" | "apng",
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
    tags: [],
    groupOnlyGreetings: [],
    creatorNotesMultilingual: {},
    sourceLinks: [],
    nickname: ""
  },
  cardAssets: [],
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
    content: "",
    activation: {
      constant: false,
      primaryKeys: [],
      secondaryKeys: [],
      selectiveLogic: "and_any" | "and_all" | "not_any" | "not_all",
      useRegex: false,
      caseSensitive: false,
      matchWholeWords: false,
      probability: 100,
      inclusionGroup: "",
      groupWeight: 100,
      delayTurns: 0,
      stickyTurns: 0,
      cooldownTurns: 0
    },
    insertion: {
      position: "before_character" | "after_character" | "before_examples" |
        "after_examples" | "at_depth",
      depth: 4,
      role: "system" | "user" | "assistant",
      order: 100
    },
    recursion: {
      preventFurtherRecursion: false,
      excludeFromRecursion: false
    },
    preservedDecorators: [],
    preservedExtensions: {}
  }],
  scanPolicy: {
    scanDepthTurns: 8,
    tokenBudget: 0,
    recursive: true,
    maxRecursionSteps: 4
  },
  contentHash: "sha256:...",
  createdAt: "ISO-8601"
}
```

The normalized model represents safe declarative semantics shared across known
formats. Version-specific fields and decorators that Lily does not implement
remain preserved and inert. Regex matching, when enabled by a known card
format, runs through a linear-time engine or an isolated worker with strict
input and elapsed-time limits; arbitrary JavaScript regex execution on the
Electron main thread is forbidden.

World-book `role` and `position` fields control ordering only inside the
lower-authority Character Worlds envelope. An imported entry labeled `system`
never becomes equal in authority to Lily's real system policy.

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

The canonical binding does not live in `sessions-index.json`. It lives in the
existing MessageStore SQLite database beside durable `turn_inputs`, so binding
changes and turn snapshots use the same ordering and transaction boundary. The
session index may expose a rebuildable display hint only; it is never consulted
to authorize or compile a turn.

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

### 7.7 Canonical persistence schema

Character metadata, revisions, bindings, and binding events use append-only
MessageStore schema migrations. Large images and preserved originals reuse the
existing content-addressed blob store and reference counting.

```text
character_entities
character_revisions
persona_entities
persona_revisions
world_book_entities
world_book_revisions
character_revision_blobs
character_session_bindings
character_binding_events
character_scene_checkpoints
turn_inputs.metadata_json.characterWorlds
```

Entity rows are mutable library pointers; revision rows are immutable canonical
JSON envelopes with hashes. A binding mutation transaction:

1. validates that every referenced immutable revision exists;
2. increments the session's `binding_version`;
3. writes the current binding;
4. appends the change event;
5. returns the committed version for renderer reconciliation.

Turn acceptance snapshots that committed version and all effective revision IDs
into the durable turn input before the turn can queue or execute. This leaves
one canonical answer after a crash. The renderer never performs optimistic
binding changes that survive a rejected main-process transaction.

## 8. Character Switching Semantics

Changing a character in an existing conversation does not create a branch and
does not mutate historical messages.

1. The user selects a new character or returns to native Lily.
2. Lily serializes the binding mutation with message acceptance for that exact
   conversation and writes a new immutable binding version and change event.
3. The new binding applies to messages accepted after the committed change.
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

Messages already accepted into the same conversation queue retain the binding
snapshot they were accepted with. A later role switch cannot reinterpret a
queued user request. A steering message belongs to the active turn and uses the
active turn's existing snapshot. This preserves user action order even under
rapid send/switch/send interactions.

Deleting or editing a library item cannot silently change an old or in-flight
conversation. Bound revision snapshots remain readable until no conversation or
turn references them.

Editing an active character or Persona creates a new revision. Existing
conversations remain pinned and show that an update is available. Applying the
new revision is an explicit binding change. A natural-language request to edit
the current role may create the revision, but it updates the active binding only
after the user approves the resulting draft.

Selecting a character in an existing conversation never injects its first
greeting into history. A newly created character conversation may offer a
greeting choice before the first user turn; the greeting becomes a normal
assistant message only after the user starts that conversation.

## 9. Turn Data Flow

```text
User message is accepted
  -> MessageStore transaction snapshots exact CharacterSessionBinding
     into the durable turn input
  -> Turn Orchestrator admits exact conversation + turn
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

The binding snapshot belongs to the accepted durable turn input, not the
currently visible UI conversation or an in-memory global. Concurrent
conversations therefore cannot read each other's character state.

Scheduled tasks inherit the binding of their exact target conversation when the
occurrence is durably accepted. They never use the character selected in the
currently focused window. Restart recovery reuses the stored snapshot rather
than resolving the conversation's newer binding.

Desktop, mobile, imported command, and scheduled-message origins all use this
same host acceptance path. A client may request a binding change by entity ID,
but the main process resolves owner scope and revisions; no client can attach
an inline role payload directly to a turn or rely on the visually focused
conversation.

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

### 10.2 OpenCode injection boundary

Character context is delivered through a dedicated per-request system-context
field in the existing OpenCode prompt body. It is never concatenated into the
visible user text, attachment extraction, or canonical conversation messages.
Otherwise an old card could persist as a historical user instruction after the
user switches roles.

The prompt builder accepts Lily guidance and Character Worlds context as
separate inputs. It composes them in authority order and applies independent
budgets:

```js
buildOpencodePromptBody({
  text,
  files,
  guidance,          // existing Lily system guidance; protected
  characterContext, // lower-authority, optional, per accepted turn
  model,
  agent
})
```

Existing Lily guardrail sections are retained first by
`truncateSystemGuidance`. Character context receives only the remaining
allocation and can be dropped completely. It cannot displace the protected
Lily identity, capability, permission, or evidence sections. OpenCode prompt
history adapters and renderer projections must prove that the hidden character
envelope never appears as a user message.

The serialized system message keeps Lily's protected prefix byte-stable and
appends a separately fingerprinted dynamic character suffix. Role changes,
world activation, and Persona changes may invalidate only the dynamic suffix.
They must not reorder or rewrite the static Lily prefix, because doing so would
reduce provider prompt-cache reuse and make role conversations slower and more
expensive than necessary.

If a provider/runtime cannot reliably carry the lower-authority per-request
system context, character compilation is disabled for that turn and Lily runs
natively. Lily does not move character instructions into a fake user message
as a compatibility workaround.

### 10.3 Budget priority

Character context consumes a bounded portion of the existing per-turn input
budget. It may never crowd out Lily's system rules, current user request,
tool/evidence context, required file context, or output reserve.

Default allocation is:

```text
character ceiling =
  min(
    remaining input tokens after protected Lily context and output reserve,
    25% of usable model input,
    16,384 tokens
  )
```

There is no guaranteed minimum: when protected Lily and user evidence need the
space, character context receives zero and the turn runs natively. Model
capability metadata drives the usable input; the existing conservative default
applies when metadata is missing. Limits are versioned constants with tests,
not user-controlled card fields.

Within the character allocation, keep content in this order:

1. Character identity and essential behavior.
2. Current scene state.
3. Persona narrative identity.
4. Constant world entries.
5. Triggered world entries by position and order.
6. Recent character episodic memory.
7. Examples and creator notes.

Lower-priority content is omitted with diagnostics. Oversized text is segmented
at normalized paragraph/message boundaries and selected by priority; the
original stored field is never mutated, and arbitrary mid-codepoint truncation
is forbidden. If essential character identity cannot fit as a coherent bounded
segment, the compiler emits no character context and runs native Lily rather
than sending a misleading fragment.

### 10.4 World-book activation

Activation is deterministic and reproducible:

- Inspect only a bounded recent conversation window plus the current user turn.
- Apply the detected format's enabled/constant status, primary and secondary
  keys, selective logic, safe regex mode, case and whole-word behavior,
  probability, inclusion groups, ordering, placement, recursion controls,
  delay, sticky, cooldown, and depth using normalized data.
- Seed probability decisions from session, turn, and entry IDs so retries of
  the same turn activate the same entries.
- Persist timed-effect state in the accepted turn's scene checkpoint so restart,
  retry, and rewind reproduce activation.
- Interpret known V3 decorators declaratively; unknown decorators remain inert
  and are reported.
- Deduplicate identical content by normalized hash.
- Stop recursion and scanning at explicit depth, entry-count, character-count,
  regex-time, and token limits.

An optional local semantic retrieval enhancement may add candidates when an
already available Lily index supports it. Deterministic card behavior remains
the baseline; missing embeddings or an unavailable optional dependency never
blocks the turn.

### 10.5 Long-session compaction

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

Every durable narrative memory item is provenance-bearing:

```js
{
  id: "uuid",
  kind: "scene_fact" | "character_belief" | "relationship" | "open_thread",
  text: "",
  sourceTurnIds: [],
  characterRevisionId: "uuid",
  confidence: "explicit" | "derived",
  supersedesId: "uuid-or-null",
  createdAt: "ISO-8601"
}
```

`character_belief` may contradict reality by design. Derived items never become
verified Lily task facts. Updates append a superseding item instead of silently
rewriting history. Group participants receive shared scene facts plus their own
memory; one character's private belief is not injected into another character
unless scene policy explicitly marks it shared.

Memory extraction runs only after a successful finalized turn. A failed,
cancelled, rewound, or interrupted turn does not advance scene or character
memory. Rewind restores the binding and memory checkpoint associated with the
retained turn boundary.

Default character memory uses bounded recent canonical history and adds no
second model request. Model-assisted durable episodic extraction is separately
opt-in, shows its provider/cost behavior, is cancellable, and runs only after
finalization. Failure or disabled background work leaves recent-history memory
available and never changes the completed answer.

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

### 12.1 Response variants and safe regeneration

SillyTavern-style response alternatives are supported only with Lily's
side-effect guarantees:

- A narrative turn with no side-effecting tools may generate and retain
  multiple assistant-text variants under one turn.
- Selecting a variant changes only the visible assistant projection and active
  narrative checkpoint; it never rewrites the user's message.
- A turn that modified files, sent data, installed dependencies, changed
  external state, or has uncertain side effects cannot be blindly regenerated.
  The user must use Lily's existing rewind/rollback flow first.
- A text-only alternative based on already archived evidence may be generated
  without rerunning tools, but it must preserve facts, citations, artifacts,
  and completion status.
- Variants are keyed by exact session and turn IDs and carry the same admitted
  character binding snapshot.

This provides creative alternatives without duplicating payments, messages,
file edits, or other real-world effects.

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

### 13.4 Accessibility and localization

The workbench supports keyboard-only selection and editing, visible focus,
screen-reader names and status announcements, reduced motion, high contrast,
zoom, long unbroken names, CJK, RTL, and localized system labels. Imported card
content remains in its original language and direction; Lily never silently
translates or rewrites it. Avatars are decorative unless the card provides
user-editable alternative text.

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
- Null-prototype normalization or equivalent protection against prototype
  pollution keys such as `__proto__`, `prototype`, and `constructor`.
- Parameterized SQL only; imported names and IDs never become SQL fragments,
  paths, IPC channel names, or HTML.

Oversized data is rejected as a character import with a precise reason but
remains eligible for Lily's ordinary local-file handling.

Default limits are centralized, versioned, and test-visible:

| Limit | Default |
|---|---:|
| Card/container input | 32 MiB |
| Decoded embedded card JSON | 8 MiB |
| JSON nesting depth | 64 |
| Single normalized text field | 1 MiB stored; compiler applies a lower turn budget |
| World-book entries per revision | 10,000 stored; at most 256 evaluated per turn after indexed candidate filtering |
| Image pixels | 40 million |
| Supported package entries | 1,000 |
| Supported package expanded bytes | 128 MiB |
| Package compression ratio | 100:1 |
| Macro nesting / expansions | 8 / 1,000 |
| World recursion steps | 4 |
| Safe-regex elapsed budget | 25 ms per entry, 100 ms per turn |

Limits protect local stability, not product capability. A limit breach reports
the exact limit and leaves the original input available to the ordinary file
path; it never partially imports a card and presents it as complete.

PNG/APNG metadata is parsed without decoding every animation frame. Avatar
rendering decodes a bounded still frame unless the UI explicitly supports and
budgets animation. Multiple card chunks, duplicate JSON keys, invalid Unicode,
and conflicting legacy mirrors are surfaced in the import report instead of
being resolved by parser accident.

### 14.2 Canonical storage

Reuse MessageStore's ordered schema migrations, SQLite transactions, and
content-addressed blob catalog:

```text
messages.db
  character_* metadata and revision tables
  character_session_bindings
  character_binding_events
  character_scene_checkpoints
  blobs + character_revision_blobs

blobs/<content-addressed hash>
  avatars
  embedded card assets
  preserved original imports
```

Migrations are additive and never edit an existing migration. SQLite owns
metadata and reference transactions; the existing blob store owns large bytes.
Content hashes provide deduplication and integrity checks. Startup validates
orphan references incrementally and quarantines only the corrupt row/blob,
never replaces a readable database with an empty store, and never blocks first
paint on a full-library scan.

Blob commit order is crash-safe: validate and hash into a temporary file, atomically
rename the content-addressed blob, then commit metadata and reference rows in
one SQLite transaction. A crash before the transaction can leave only an
unreferenced blob for later GC; a committed revision never intentionally points
to bytes that were not already durably placed. Export and active-turn leases
pin referenced blobs against concurrent GC.

### 14.3 Assets and privacy

- Avatars and originals stay local by default.
- Remote URLs are text metadata until the user explicitly requests retrieval.
- Export excludes conversation history and episodic memory unless the user
  explicitly includes them.
- Imported creator metadata is displayed as card data, not trusted identity.
- Telemetry contains only coarse format, success/failure code, and bounded
  counts. It never includes card text, Persona text, world content, or images.

Imported HTML is never rendered directly. Card text uses escaped text or the
same sanitized Markdown pipeline as normal Lily messages. Remote Markdown
images, fonts, audio, CSS, and link previews do not auto-load, preventing IP
leakage and tracking. Explicit remote retrieval goes through Lily's existing
network permission and URL-safety path, blocks local/private network targets
and credential-bearing URLs, validates MIME/signature/size, and stores the
result as a local content-addressed asset.

Model-provider content and safety policies still apply to generated responses.
Importing a locally stored card does not weaken provider safety behavior or
cause Lily to upload the library for scanning. Content leaves the machine only
when it is part of context for a user-initiated model turn, under the same
provider disclosure and privacy behavior as ordinary Lily conversation text.

### 14.4 Portability and workspace packages

Character libraries are profile-local by default. Workspace export does not
silently include private characters, Personas, worlds, scenes, or episodic
memory.

Every entity also carries an immutable host-derived `ownerScope`. Authenticated
account changes hide foreign private libraries and prevent foreign bindings
from compiling, while preserving their local bytes for the original owner.
Anonymous local use has a distinct device-local owner scope. Renderer payloads
cannot choose or overwrite this scope.

When the user explicitly includes Character Worlds data:

- the export preview lists every included entity and asset;
- only revisions referenced by the selected workspace/session package are
  copied;
- account data, credentials, absolute local paths, runtime events, and
  unrelated library entries are excluded;
- imported entities receive new local IDs while internal references are
  remapped;
- executable/unknown fields remain inert and pass through the same hostile
  import pipeline;
- conversation bindings are restored only when their referenced revisions
  imported successfully, otherwise the conversation opens in native Lily;
- episodic memory and scene history are separately opt-in.

This extends the existing reviewed workspace-package flow rather than creating
a second archive extractor or auto-import route.

### 14.5 Performance requirements

- Native mode performs no card parsing, macro expansion, world scan, memory
  extraction, or extra model call.
- Binding lookup/snapshot is part of the existing synchronous turn-acceptance
  transaction and targets a p95 overhead below 2 ms on supported hardware.
- Normal character compilation targets p95 below 50 ms; 200 ms is the local
  performance warning threshold. Deterministic work terminates by
  input/count/depth bounds rather than killing legitimate evolving work on a
  wall-clock timeout.
- Image/container parsing and large-library maintenance run off the renderer
  and Electron main-thread hot paths.
- Startup never scans or hashes the full character library.
- Search is indexed and paginated; library size does not change per-turn lookup
  complexity for a bound immutable revision.
- Character mode introduces no additional model request on the normal turn
  path. Optional semantic indexing and model-assisted memory maintenance require
  explicit enablement, disclose provider/cost behavior, run after successful
  finalization, and are cancellable.

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
| Missing/corrupt bound revision | Record a per-turn diagnostic, preserve the binding for recovery, run native Lily |
| Import parse failure | Keep original file untouched; offer ordinary attachment analysis |
| Unsupported fields | Preserve inert data, report it, use supported card fields |
| Unknown/failing macro | Keep it literal, report it, continue with safe content |
| World resolver failure | Use character without world entries |
| Character memory failure | Continue without episodic memory |
| Context compiler failure | Dispatch the original turn with native Lily |
| Context over budget | Drop lower-priority character content; never core Lily context |
| Provider cannot carry safe system context | Do not emulate with a user message; run native Lily |
| Scene coordinator failure | Fall back to selected primary character, then native Lily |
| Optional semantic index unavailable | Use deterministic world-book matching |
| Character deleted during a turn | Finish with the admitted immutable revision |
| App restart during a switch | Recover the committed binding event atomically |
| Concurrent session activity | Resolve binding only by exact admitted session ID |
| Rewind | Restore binding/memory checkpoint at retained turn boundary |
| Workspace import misses a referenced card | Open imported conversation in native Lily and report the omission |

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

Binding mutation, normal message acceptance, scheduled occurrence acceptance,
steering, rewind, and deletion all participate in the session's ordered host
admission protocol. Tests must force interleavings around every transaction
boundary; timing assumptions or renderer focus are not accepted as isolation.

## 18. Migration And Rollout

### Phase 1: Safe foundation

- Canonical schemas, asset store, validation, revisioning, and import reports.
- Character Card V1 import migration and V2/V3 JSON/PNG/APNG import/export.
- Safe deterministic macro compatibility.
- Optional single-character session binding.
- Transactional binding snapshots, dedicated per-request context injection, and
  Capability Gate fallback.
- Lily original voice remains the default.

### Phase 2: Native authoring

- Character, Persona, and world-book creation/editing.
- Natural-language draft creation through validated domain APIs.
- Revision history, restore, archive, and library management.
- Character switching timeline events.
- Explicit workspace-package portability.

### Phase 3: Depth

- Full deterministic world-book activation semantics.
- Scene state and per-character episodic memory.
- Group/story modes.
- Side-effect-safe response variants.
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

All database changes are additive tables/columns. Rolling back to an older Lily
binary leaves the unknown Character Worlds tables untouched and runs
conversations in native Lily; the older binary must not reject a higher
`user_version` or rewrite the database. Rolling forward restores the bindings.
Feature disablement never drops tables or blobs. Revision/blob garbage
collection runs only after no entity, binding, turn snapshot, scene checkpoint,
or export lease references the revision.

## 19. Verification Strategy

### 19.1 Parser and compatibility fixtures

- Valid legacy Character Card V1 import and explicit migration report.
- Valid Character Card V2 JSON.
- Valid V2 PNG with embedded data.
- Valid Character Card V3 JSON, PNG, and APNG with V3 winning over a legacy
  embedded payload.
- Unicode and multilingual cards.
- Multiple and group-only greetings, assets, safe macros, V3 metadata, and
  embedded character books.
- Unchanged originals export byte-stably; edited cards export semantically with
  an explicit conflict report.
- Unknown extensions, decorators, and future versions remain inert.
- Truncated PNG, invalid base64, malformed JSON, excessive nesting, oversized
  strings, duplicate IDs, regex denial-of-service patterns, macro expansion
  bombs, conflicting chunks, and hostile archive paths.
- A corpus of real-world cards whose licenses permit test inclusion, plus
  synthetic edge cases for every limit.

### 19.2 Authority tests

- A card cannot override Lily identity or system rules.
- A card cannot change model, tool, skill, permission, project, or account.
- A card asking Lily to ignore evidence cannot bypass evidence gates.
- A card asking Lily not to use tools cannot suppress tools required by the
  admitted task contract.
- Task classification and tool intent are identical with and without the
  malicious role envelope because both derive from the original user request.
- Role voice cannot alter code, commands, JSON, formulas, citations, exact
  values, file paths, or requested machine-readable output.
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
- Provider/runtime without a safe per-request system channel.

All cases must preserve the native Lily task path, files, tools, evidence, and
finalization. Add this new regression vector to `CAPABILITY-GATE.md`.

### 19.4 Session and concurrency tests

- Two conversations use different characters concurrently.
- One conversation is native while another uses a role.
- Switching during a running turn affects only the following turn.
- A message queued before a switch keeps its previous binding; a message
  accepted after the switch gets the new binding.
- A steering message retains the active turn's binding.
- Switching never rewrites historical messages.
- Revision edits do not mutate bound old turns.
- Scheduled work uses its target conversation, not the focused conversation.
- Account switching hides foreign private libraries and causes a foreign
  binding to fall back without deleting the original owner's data.
- Restart, queue recovery, compaction, rewind, deletion, and archive restore
  preserve exact binding boundaries.
- The hidden role envelope never appears in canonical user history or renderer
  projections.
- Captured OpenCode requests prove each resumed turn receives only its admitted
  current role envelope; role switches and native compaction cannot resurrect
  a previous card's hidden instructions.
- Explicit workspace export/import remaps IDs without leaking unrelated
  profile content; missing references fail to native Lily.
- Group scenes never duplicate side-effecting tool calls.
- Response variants never rerun side-effecting tools without rewind.

### 19.5 Budget and memory tests

- Core Lily context always outranks all character content.
- World entries activate deterministically on retry.
- Regex, recursive activation, macros, timed effects, and inclusion groups are
  deterministic and terminate within limits.
- Trimming occurs by whole low-priority items or safe paragraph boundaries.
- Compaction remembers switches without promoting old role instructions.
- Narrative memory cannot overwrite task evidence.
- Rolling back to a pre-feature binary runs native conversations without
  deleting the additive tables; rolling forward restores the same bindings.

### 19.6 End-to-end release acceptance

Run a natural-language acceptance pack that verifies:

1. Complete a file-and-tool task in native Lily.
2. Select a role and complete the same task with role-appropriate expression.
3. Switch roles mid-conversation and verify next-turn-only behavior.
4. Return to Lily original voice and verify baseline behavior.
5. Import/export multilingual V1/V2/V3 fixtures with the promised round-trip
   behavior.
6. Activate Persona and world-book entries.
7. Run two differently bound conversations concurrently.
8. Trigger parser, resolver, and compiler faults and verify native fallback.
9. Restart, compact, rewind, and resume without binding or memory bleed.
10. Verify no imported code, URL, plugin, script macro, or side-effecting macro
    executes; safe allowlisted text macros expand deterministically.
11. Verify an Agent task produces identical tools/evidence/artifacts in native
    and role modes while only safe conversational prose changes.
12. Verify workspace portability and side-effect-safe response variants.

### 19.7 Release gates

The feature does not graduate from a phase flag until:

- the full existing Lily unit suite and Capability Gate suite pass;
- deterministic native-versus-role Agent tasks have 100% parity for required
  tools, permissions, evidence, artifacts, and machine-readable output;
- every licensed compatibility fixture imports and exports at its declared
  compatibility level with zero unreported field loss;
- parser/property fuzzing completes at least 100,000 generated hostile inputs
  with no crash, hang, network access, path escape, or partial committed import;
- randomized concurrent send/queue/switch/steer/schedule/restart testing
  completes at least 10,000 operation schedules with no cross-session binding;
- the supported-model evaluation matrix shows no statistically significant
  task-quality regression beyond a 3 percentage-point non-inferiority margin
  at 95% confidence, while at least 90% of narrative cases satisfy the selected
  character's identity and style rubric;
- adversarial cards produce zero unauthorized host actions and zero instances
  where role data changes task classification or permission scope;
- performance targets pass on the slowest supported ordinary-hardware profile;
- keyboard, screen-reader, zoom, CJK, and RTL acceptance passes on every shipped
  operating-system family.

The quality corpus, rubric, native baselines, model settings, random seeds, and
raw outcomes are versioned release artifacts. Deterministic assertions score
tools, evidence, formats, and protected spans. Narrative quality uses blinded
independent judging plus a human audit sample; the model under test is never the
only judge of its own output.

Rollout is phase-flagged with an immediate local/server kill switch and staged
exposure. Promotion decisions use only privacy-safe counts and error codes.
Card text, world content, Persona data, memory, and images never enter rollout
telemetry.

## 20. Observability

Each archived turn records bounded metadata:

```js
{
  characterWorlds: {
    enabled: true,
    mode: "character",
    bindingVersion: 7,
    detectedCardSpec: "v3",
    characterRevisionId: "uuid",
    personaRevisionId: "uuid-or-null",
    worldBookRevisionIds: [],
    sceneId: null,
    contextFingerprint: "sha256:...",
    activatedEntryCount: 4,
    omittedEntryCount: 2,
    tokenEstimate: 2400,
    compatibility: {
      prompts: "safe_behavior",
      macros: "safe_behavior",
      extensions: "preserved_inert"
    },
    fallback: null,
    warnings: []
  }
}
```

Diagnostics expose activation reasons and omissions without logging private
content. User-facing errors remain concise. Developer diagnostics can identify
the exact session, turn, revision, compiler stage, and fallback reason.

Renderer acceptance includes automated screenshots at supported desktop and
compact/mobile projection widths with long names, CJK, RTL, zoom, empty,
loading, corrupt-card, and switch-during-turn states. Text, avatars, markers,
menus, and composer controls must not overlap or shift the conversation layout.

## 21. Acceptance Criteria

The design is complete when implementation can prove all of the following:

- An empty binding is behaviorally equivalent to Lily before this feature.
- Character selection is optional, conversation-scoped, revision-pinned, and
  safe under concurrent activity.
- A role switch affects the next admitted turn and never rewrites history.
- Character data changes voice and narrative context without reducing Agent
  capability or bypassing host controls.
- Persona is strictly narrative.
- Character Card V1 migration and V2/V3 JSON/PNG/APNG plus supported world-book
  data import safely and preserve unknown fields inertly.
- Safe macros behave deterministically while script and side-effecting macros
  remain inert.
- Imported executable behavior never runs.
- World activation and context trimming are deterministic, bounded, and
  inspectable.
- Long-session compaction, scheduled turns, restart recovery, rewind, and
  deletion preserve isolation and correct binding history.
- Every subsystem failure degrades to current Lily behavior.
- Native mode adds no parsing or model work, and role-mode local overhead stays
  within the declared performance budgets.
- Automated regression tests guard the feature in `CAPABILITY-GATE.md`.

## 22. Decision Summary

The approved direction is a Lily-native Character Worlds capability, not a
SillyTavern embed. Compatibility is at the declarative data boundary. Lily
remains the sole Agent kernel and authority owner.

This produces the desired combination: users can bring any safe standard role
card into an individual conversation, or select nothing and use Lily's original
voice, while Lily retains its full ability to reason, use tools, operate on
files, coordinate subagents, verify work, and recover from failures.
