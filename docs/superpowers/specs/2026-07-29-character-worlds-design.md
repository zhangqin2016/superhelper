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

Expansion uses a real template lexer/parser, never chained regular-expression
replacement. Macro handlers are registered pure functions over an immutable
turn snapshot. The evaluator maintains an expansion stack for cycle detection,
counts nested calls and output code points, and uses the turn's deterministic
counter-based PRNG for supported random text macros.

Expansion phases are fixed:

1. Parse and validate templates at revision-index build time.
2. Resolve base identity/session macros in matching keys and explicitly enabled
   matching sources for the admitted binding.
3. Run world-book activation and produce insertion buckets.
4. Resolve non-nesting outlet macros from the selected buckets.
5. Expand safe content macros in selected character/world/memory segments.
6. Tokenize, pack, and serialize the final envelope.

Macros never generate new executable macro syntax for a later unrestricted
pass. A handler can return text only; newly returned delimiters stay literal
unless that specific macro contract permits one bounded recursive expansion.
Cache keys include macro-policy version and all snapshot fields used by
expansion.

### 4.4 Licensing strategy

Implementation is clean-room and based on public data-format behavior and
documentation. Lily must not copy SillyTavern AGPL source or ship its UI,
extensions, or server plugin runtime unless a separate legal decision accepts
the resulting obligations.

Reference documentation:

- [SillyTavern repository](https://github.com/SillyTavern/SillyTavern)
- [Characters](https://docs.sillytavern.app/usage/characters/)
- [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [Group Chats](https://docs.sillytavern.app/usage/core-concepts/groupchats/)
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

### 6.2 Expression-profile algorithm

`CharacterCapabilityPolicy` derives an expression profile from Lily's existing
host-built task contract before character content is attached:

```text
immersive
  narrative dialogue, roleplay, scene continuation, creative conversation

balanced
  ordinary advice or explanation where role voice can cover prose but facts,
  citations, and structured blocks stay protected

task_preserving
  tools, files, code, research, evidence, transactions, exact text,
  machine-readable output, or high-stakes work
```

The user's explicit request may ask for a role-styled artifact or fully
in-character explanation, but the card itself cannot select a weaker profile.
Ambiguous classification fails to `task_preserving`. The profile controls which
card segments are eligible, how much world/memory context is packed, and which
output spans are protected. It never changes model route, tool availability,
permission mode, task rigor, or output reserve.

The same original request must produce the same task contract and execution
profile whether no card, a normal card, or an adversarial card is selected.

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
      selective: false,
      selectiveLogic: "and_any" | "and_all" | "not_any" | "not_all",
      useRegex: false,
      vectorized: false,
      caseSensitive: false,
      matchWholeWords: false,
      probability: 100,
      inclusionGroups: [],
      groupWeight: 100,
      prioritizeInclusion: false,
      useGroupScoring: false,
      characterFilter: {
        mode: "include" | "exclude",
        characterNames: [],
        characterTags: []
      },
      generationTriggers: [],
      matchSources: [],
      delayMessages: 0,
      stickyMessages: 0,
      cooldownMessages: 0
    },
    insertion: {
      position: "before_character" | "after_character" | "before_examples" |
        "after_examples" | "author_note_top" | "author_note_bottom" |
        "at_depth" | "outlet",
      depth: 4,
      role: "system" | "user" | "assistant",
      outletName: "",
      order: 100,
      priority: null
    },
    recursion: {
      preventFurtherRecursion: false,
      excludeFromRecursion: false,
      delayUntilRecursion: false,
      recursionLevel: 0
    },
    preservedDecorators: [],
    preservedExtensions: {}
  }],
  scanPolicy: {
    scanDepthMessages: 8,
    includeParticipantNames: true,
    tokenBudget: 0,
    recursive: true,
    maxRecursionSteps: 4,
    minActivations: 0,
    maxDepthMessages: 0
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
  compatibilityProfileVersion: 1,
  mode: "native" | "character" | "group" | "story",
  activeCharacterRevisionId: "uuid-or-null",
  activePersonaRevisionId: "uuid-or-null",
  activeGreetingIndex: "integer-or-null",
  worldBookBindings: [{
    revisionId: "uuid",
    scope: "chat" | "persona" | "character" | "global"
  }],
  worldResolutionPolicy: {
    sourceMergeStrategy: "sorted_evenly" | "character_first" | "global_first"
  },
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

The compatibility profile pins behaviorally visible parsing, matching,
insertion, macro, and group semantics for the conversation. A Lily upgrade may
use a newer profile for new bindings, but does not silently change an existing
long conversation. Explicit migration creates a binding event with a previewed
compatibility report. Security policy and resource limits are separate,
monotonic host controls: an old compatibility profile can never restore an
unsafe parser, executable behavior, weaker permission, or obsolete security
limit.

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

1. requires the caller's `expectedBindingVersion`;
2. validates that the current version still matches and every referenced
   immutable revision exists under the host owner scope;
3. increments the session's `binding_version`;
4. writes the current binding;
5. appends the change event;
6. returns the committed version for renderer reconciliation.

A version mismatch returns the latest binding without modifying state. Desktop,
mobile, and concurrent renderer windows therefore cannot silently overwrite
one another. Entity editing similarly requires `baseRevisionId`; a stale edit
is retained as a draft/conflict and never replaces the current revision without
explicit resolution.

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

Every internal continuation, evidence-recovery prompt, model self-heal retry,
and safe replay for a turn reuses that turn's admitted binding snapshot. It
never resolves the session's newer current binding mid-turn. A steering message
also retains the binding snapshot, but may rerun the pure world resolver against
the expanded active-turn corpus so newly mentioned lore can activate. Timed
effects advance once at finalization, not once per steer or retry.

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
    reason: "constant | primary_key | selective_match | semantic | recursion | sticky",
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

Packing is deterministic lexicographic packing, not a generic knapsack:

1. Reserve protected Lily, current request, evidence, and output space.
2. Compute exact tokens with the active model tokenizer when available, or use
   the existing conservative provider-aware estimator.
3. Order components by authority category, source priority, activation reason,
   insertion order, and stable revision/entry ID.
4. Add indivisible entries or safe paragraph segments while they fit.
5. Record every omitted unit and reason.

The compiler never chooses several low-authority lore entries over required
character identity merely because they produce a higher aggregate score.
Identical inputs, binding snapshots, model metadata, and seeds produce the same
packed envelope and fingerprint.

#### 10.3.1 Envelope assembly order

After selection and packing, assemble a typed envelope in this order:

1. Character mode and expression-profile contract.
2. Card main/system prompt, explicitly demoted under Lily policy.
3. World entries positioned before character definitions.
4. Character name, description, personality, and scenario.
5. World entries positioned after character definitions.
6. Persona narrative description and current structured scene state.
7. World entries positioned before examples.
8. Bounded example dialogue.
9. World entries positioned after examples.
10. Selected episodic memories and open narrative threads.
11. Author's Note top/body/bottom compatibility buckets.
12. Post-history instructions, still inside the lower-authority envelope.
13. Depth and outlet compatibility buckets with explicit placement labels.

Each block has a type, source revision, content hash, token count, and
compatibility level. Empty blocks disappear. The serializer uses a canonical
JSON envelope with escaped string fields and a fixed Lily-owned prologue, so
card text cannot close a block or impersonate a Lily layer.

OpenCode does not receive fabricated historical user/assistant messages for
examples or depth insertion. Where the runtime cannot represent a source
position exactly without corrupting canonical history, Lily serializes the
position inside the dynamic system suffix and reports `safe_behavior` rather
than `lossless_data`.

### 10.4 World-book activation

World-book activation is a pure resolver over an immutable turn snapshot. Its
only output is an insertion plan plus the next timed-effect checkpoint.

#### 10.4.1 Prepare sources and scan corpus

1. Resolve chat-, Persona-, character-, and optional profile-global book
   revisions from the admitted binding.
2. Apply source precedence: chat and Persona lore first; character and global
   lore follow the selected merge strategy. Source precedence breaks ties but
   never bypasses entry insertion order.
3. Build the scan corpus from the configured number of canonical messages. If
   names are enabled, prefix each message with a stable participant separator
   and resolved display name so regexes cannot match across accidental message
   boundaries.
4. Add only explicitly enabled matching sources such as description,
   personality, scenario, Persona description, character note, or creator
   notes. Matching sources are not automatically inserted into the prompt.
5. Normalize a matching copy to Unicode NFC and apply version-pinned Unicode
   default case folding when case-insensitive; never inherit the host OS locale.
   Preserve original content for insertion and export. Whole-word matching uses
   Electron's bundled, version-recorded ICU segmentation behavior; CJK entries
   can disable whole-word mode as declared by the card.

Plain keys use a compiled multi-pattern index grouped by case and word
semantics, avoiding `entries x keys x corpus` substring loops. Regex keys are
first reduced by enabled/generation/character/timed filters, then evaluated in
deterministic priority order through the isolated bounded regex path. If the
regex candidate cap is exceeded, omitted entry IDs/reasons are reported rather
than silently pretending complete evaluation.
Macro-free indexes are immutable and cached by world-book revision hash.
Indexes containing expanded dynamic keys additionally key by the base-macro
expansion fingerprint and locale/segmentation mode.
The matching-policy version includes Unicode/ICU behavior so upgrades invalidate
indexes explicitly and cross-platform fixtures detect drift.

#### 10.4.2 Produce initial candidates

Candidates come from:

- enabled constant entries;
- primary-key matches that pass secondary selective logic;
- optional local semantic matches for entries that permit vector activation;
- active sticky effects from the previous checkpoint.

For every candidate, record source scope, matching keys, key-match count,
activation route, recursion level, and stable content hash. Apply generation
trigger and character/tag filters before probability. Apply delay and cooldown
against canonical message sequence numbers, not wall time or user/assistant
pairs.

Probability uses a counter-based deterministic PRNG keyed by owner scope,
session ID, turn ID, world revision, entry ID, and activation phase. Evaluation
order therefore cannot change random outcomes. Sticky carry-over skips repeat
probability when its compatibility profile requires that behavior.

The PRNG is a specified SHA-256 counter construction, not `Math.random` or a
home-grown mutable generator. Probability maps fixed high bits to a documented
uniform interval; weighted group choice uses integer cumulative weights with
rejection sampling to avoid modulo bias. Algorithm/version are archived so an
upgrade cannot silently change an old turn's replay.

#### 10.4.3 Resolve inclusion groups

An entry may belong to multiple groups. Build a conflict graph where entries
share an edge when they share any inclusion group:

1. Optionally retain only the highest key-match score in each group.
2. With prioritized inclusion, choose highest insertion order, then stable
   entry ID.
3. Otherwise use deterministic weighted selection from `groupWeight`.
4. Remove all entries conflicting with a selected winner.
5. Repeat in stable connected-component order until no conflict remains.

The trace records candidates, scores, seed identity, winners, and eliminations
without recording private matched text.

#### 10.4.4 Recursion and minimum activation

Activated content can trigger other entries. Resolve this as a bounded fixed
point:

1. Add newly activated content to a separate recursion corpus.
2. Never reactivate an already selected entry in the same turn.
3. Exclude entries marked non-recursable and stop propagation from entries
   marked `preventFurtherRecursion`.
4. Admit `delayUntilRecursion` entries only at their declared recursion level.
5. Rerun filters, probability, and inclusion conflict resolution for each new
   frontier.
6. Stop at no new entries, token/entry budget, or configured recursion steps.

`minActivations` and `maxRecursionSteps` are mutually exclusive compatibility
policies. In minimum-activation mode, progressively scan older canonical
messages up to `maxDepthMessages` until the minimum is met or the budget is
exhausted; each new chat sweep can then start its own bounded recursion
frontier. Cycles terminate because selection is monotonic by stable entry ID.

#### 10.4.5 Budget and insertion plan

Apply compatibility priority before packing:

1. Sticky and constant entries.
2. Direct chat matches.
3. Other explicit matching-source matches.
4. Recursive matches.
5. Optional semantic matches.

Within each class, apply source merge strategy and insertion order. Budget
selection considers explicit `priority` first and otherwise larger
insertion-order values when compatibility semantics give them higher budget
priority. Prompt position is separate: after selected entries fit, render each
bucket in the required order so larger insertion-order values land closer to
the end where specified. Place entries into before/after
character, before/after examples, Author's Note
top/bottom, depth-role, or named outlet buckets. Outlet expansion is
case-sensitive, non-nesting, and uses the safe macro engine. Unsupported Lily
positions map to a documented lower-authority envelope position and report
`safe_behavior`; they never silently claim exact parity.

#### 10.4.6 Timed-effect transition

Compute sticky, cooldown, and delay state from canonical message sequence
numbers after final selection. Consequent matches do not refresh a running
effect unless the detected compatibility profile explicitly requires it.
Variant selection, rewind, deletion, entry revision change, retry, and restart
restore or invalidate checkpoints at their retained turn boundary. Persist the
next checkpoint transactionally only after successful turn finalization. The
single checkpoint transition applies every committed message-sequence increment
in that turn, including accepted steering messages; retries and response
variants contribute no additional message increment.

#### 10.4.7 V3 decorator compilation

At immutable revision-index build time, parse leading V3 decorator lines into a
typed AST and remove recognized directive lines from insertable content:

- validate value type and range before a decorator can affect behavior;
- for duplicate single-value decorators, use the specification's first-value
  rule;
- evaluate `@@@` fallback chains top-to-bottom with a supported chain depth of
  at least five;
- compile activation-count, greeting-index, scan-depth, role, position, depth,
  reverse-depth, and stateful match decorators into the normalized entry plan;
- apply specified precedence, such as explicit position overriding depth;
- preserve unknown or invalid decorators inertly and report them;
- never treat decorator text as a macro, script, or Lily instruction.

Decorator AST and compatibility decisions are part of the revision index hash,
trace, and cross-version golden fixtures.

Every stage is deterministic and traceable. Stop recursion and scanning at
explicit depth, entry-count, corpus-character, regex-time, and token limits.
Interpret known V3 decorators declaratively; unknown decorators remain inert
and appear in the compatibility report.

An optional local semantic retrieval enhancement may add candidates when an
already available Lily index supports it. Deterministic card behavior remains
the baseline; missing embeddings or an unavailable optional dependency never
blocks the turn.

Semantic indexes are immutable snapshots keyed by source revision hashes,
embedding provider/model/version, dimensions, normalization policy, and index
algorithm version. The admitted turn records the semantic index version and
candidate IDs. Retry/restart reuses that snapshot; if it is unavailable, Lily
uses deterministic lexical activation rather than silently querying a newer
index.

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

### 10.6 Complexity envelope

Let `B` be total normalized book bytes, `C` scan-corpus bytes, `K` total plain
key bytes, `E` bounded candidate entries, `G` inclusion memberships, and `R`
bounded recursion steps.

- Revision index build is `O(B + K)` and happens once per immutable hash.
- Plain-key scan is `O(C + matches)` per scan frontier using the compiled
  multi-pattern indexes.
- Regex work is separately candidate- and time-bounded.
- Candidate filtering and grouping target `O(E log E + G)`.
- Recursive resolution is bounded by `R * (scan + matches + E log E + G)`.
- Packing is `O(E log E)` with exact token work bounded by selected content.
- Timed-state transition is linear in activated/timed entries.

No normal turn performs work proportional to the user's entire character
library or entire unbounded conversation. Limits and complexity counters are
included in diagnostics and benchmark fixtures.

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

### 11.1 Memory update and retrieval algorithm

Durable memory is an event-sourced cache over canonical conversation history,
not a second source of truth.

Update:

1. Start only from a successfully finalized canonical turn and its admitted
   character/scene snapshot.
2. Produce schema-constrained candidate items with source turn IDs. Explicit
   user statements are marked `explicit`; model-inferred relationships,
   beliefs, and open threads are marked `derived`.
3. Validate owner/session/revision scope, text and item limits, source-turn
   existence, and prohibited task/account/file-fact categories.
4. Compare candidates only with active non-superseded items in the same scope.
   Exact duplicates collapse by normalized hash; explicit corrections append a
   `supersedesId`; unresolved contradictions coexist as separate beliefs.
5. Commit items and the scene checkpoint in one transaction. Rewind or deletion
   invalidates descendants by source-turn lineage rather than editing rows.

Retrieval:

1. Filter by exact owner, session, active character revision, scene visibility,
   non-superseded state, and retained source lineage.
2. Always consider explicit current-scene facts and unresolved open threads.
3. Build bounded candidates using lexical keys from the current turn and recent
   history; optional local semantic retrieval may add candidates but never
   remove lexical/explicit candidates.
4. Rank lexicographically by visibility, explicitness, current-scene status,
   direct lexical match, optional semantic relevance, recency, then stable ID.
5. Apply diversity by memory kind and source turn so near-duplicates cannot
   consume the budget.
6. Pack whole memory items under the Character Worlds budget and record omitted
   IDs/reasons.

The same snapshot and query produce the same selected memory IDs. If source
lineage cannot be verified, the item is omitted and queued for repair; Lily
does not inject an unprovable stale memory merely because its embedding score
is high.

Memory semantic retrieval follows the same immutable index-version rule as
world books. Changing embedding models builds a new index generation in the
background and atomically promotes it only for future admitted turns.

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
  replyStrategy: "manual" | "natural" | "list_order" | "pooled" | "semantic",
  promptMode: "swap" | "join_exclude_muted" | "join_include_muted",
  allowMultipleSpeakers: true,
  allowSelfResponses: false,
  mutedCharacterRevisionIds: [],
  lastSpeakerRevisionIds: [],
  activeGreetingIndexByRevisionId: {},
  scenarioOverride: "",
  sceneState: {},
  updatedAt: "ISO-8601"
}
```

Speaker selection uses a deterministic host planner plus model judgment only
where semantic judgment is useful:

1. Validate participants and filter archived, missing, foreign-owner, or
   explicitly muted revisions, except an explicit force-talk request may select
   a muted member.
2. `manual`: use only the validated explicitly requested speakers.
3. `natural`: extract Unicode whole-word participant-name mentions from the
   latest canonical message; suppress self-mention replies unless enabled;
   evaluate unmentioned members independently by deterministic talkativeness
   probability; if none activate, choose one unmuted participant with the
   versioned deterministic PRNG.
4. `list_order`: draft eligible participants in stable configured list order.
5. `pooled`: choose deterministically from participants who have not spoken
   since the latest canonical user message; reset the pool only after all have
   spoken or a new user message arrives.
6. `semantic`: first apply the same hard eligibility filters, then give the
   bounded roster to the primary Lily Agent in the same turn. The Agent chooses
   speaker IDs while producing the response; no extra coordinator model call is
   required.
7. Validate returned speaker IDs and labels. Unknown/duplicate IDs are removed.
   Empty or malformed selection falls back to the explicitly active speaker,
   then deterministic natural fallback, without rerunning tools.

Selection inputs and tie-breakers are archived, so retry and restart choose the
same fallback. Speaker selection affects expression, not tool authority.

`promptMode: "swap"` is the default: compile only the active speaker's full
card plus bounded shared scene/participant summaries. Join modes combine the
declared safe fields of all included members in stable list order with
per-character typed boundaries and per-member macro expansion. Join mode is
reported as behaviorally risky because models may merge identities; a card
cannot enable it. The user's scenario override supersedes member scenarios only
inside the lower-authority scene layer.

One user turn remains one Lily parent turn:

- The primary Agent may render multiple clearly labeled character voices.
- Tool work is planned and executed once through Lily's normal control plane.
- Fictional participants do not each spawn an autonomous privileged Agent.
- Subagents may still be used for real research or work under Lily's existing
  depth, evidence, and permission constraints.

This avoids multiplied costs, duplicate side effects, conflicting file edits,
and loss of evidence while preserving group interaction. It is intentionally
`safe_behavior`, not a claim of byte-for-byte SillyTavern sequential-generation
parity.

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

### 14.1.1 Import algorithm

Import is preview-then-commit:

1. Stream-hash the original and sniff the real container signature.
2. Parse only bounded metadata/chunks; prefer a valid newer declared payload
   over a legacy mirror according to the compatibility profile.
3. Decode with strict UTF-8/base64 rules and a duplicate-key-aware JSON parser.
4. Validate the declared schema before applying defaults. Preserve unknown
   fields separately from normalized safe fields.
5. Expand no macros and fetch no assets during import. Compile an import report,
   canonical hash, asset manifest, and compatibility map.
6. Return an immutable preview token bound to the original hash and parsed
   result. Any source-byte change invalidates the preview.
7. On explicit commit, revalidate the preview token, place blobs, and write
   entity/revision/provenance rows transactionally.

Exact original-hash duplicates reuse the existing original blob and offer the
existing entity instead of creating an accidental copy. Canonically equivalent
cards with different originals keep distinct provenance and require an explicit
merge/replace choice. Import never guesses that a same-named character is an
update.

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

Blob commit order is crash-safe: validate and hash into a temporary file,
atomically rename the content-addressed blob, then commit metadata and reference
rows in one SQLite transaction. A crash before the transaction can leave only
an unreferenced blob for later GC; a committed revision never intentionally
points to bytes that were not already durably placed. Export and active-turn
leases pin referenced blobs against concurrent GC.

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
session-character:set-binding(expectedBindingVersion)
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

Cache policy:

- Parsed revisions key by canonical revision hash and parser-policy version.
- Plain-key/regex indexes key by world revision hash, matching-policy version,
  base-macro expansion fingerprint, and locale/segmentation mode.
- Token counts key by content hash plus tokenizer/model identity.
- Turn activation and packed envelopes key by admitted binding fingerprint,
  canonical history fingerprint, timed-state checkpoint, generation type,
  model budget, and policy version.
- Caches are bounded LRU stores with owner scope in every key, single-flight
  concurrent construction, and negative-result expiry. Exceptions never become
  durable cache entries.

An immutable revision makes invalidation structural: editing creates a new hash
instead of mutating cached data. Memory pressure drops caches without affecting
canonical state or turn correctness.

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

- Complete supported safe-declarative world-book resolver with compatibility
  traces for every implemented behavior.
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
- Expression-profile fixtures prove narrative requests select `immersive`,
  mixed explanations select `balanced`, grounded/tool/machine-readable work
  selects `task_preserving`, and ambiguity fails to `task_preserving`.
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
- Concurrent desktop/mobile binding changes with the same expected version
  commit exactly one winner and return the latest state to the loser; stale card
  edits remain drafts instead of overwriting a newer revision.
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
- Compatibility-profile upgrades leave existing sessions stable until an
  explicit binding migration, while current security limits still override an
  unsafe historical behavior.
- Explicit workspace export/import remaps IDs without leaking unrelated
  profile content; missing references fail to native Lily.
- Group scenes never duplicate side-effecting tool calls.
- Response variants never rerun side-effecting tools without rewind.

### 19.5 Algorithm, budget, and memory tests

- Core Lily context always outranks all character content.
- Generated small-world fixtures compare the indexed plain-key matcher against
  a simple Unicode-aware reference matcher.
- Shuffling candidate iteration order cannot change deterministic probability,
  inclusion-group winners, packed output, or fingerprints.
- Generated overlapping inclusion groups compare the conflict resolver against
  a slow reference implementation.
- World entries activate deterministically on retry.
- Regex, recursive activation, macros, timed effects, and inclusion groups are
  deterministic and terminate within limits.
- Recursive cycles, delayed recursion levels, minimum-activation backscan, CJK
  matching, participant separators, source merge strategies, outlets, and
  generation filters have golden traces.
- Unicode matching traces are byte-identical across every shipped OS/architecture
  for the pinned Electron/ICU version.
- A model-based state-machine test covers sticky/cooldown/delay transitions
  across normal messages, steers, variants, rewind, deletion, restart, and card
  revision changes.
- Trimming occurs by whole low-priority items or safe paragraph boundaries.
- Token packing is monotonic: increasing the available character budget cannot
  remove a higher-priority already selected item.
- Compaction remembers switches without promoting old role instructions.
- Narrative memory cannot overwrite task evidence.
- Memory source-lineage tests prove rewind/deletion removes descendants,
  supersession remains append-only, and private character beliefs never cross
  participants or sessions.
- Group-speaker tests cover manual, natural, list-order, pooled, and semantic
  strategies; explicit addressing; self-response policy; ambiguous names;
  talkativeness probability; muted/missing participants; malformed
  model-selected IDs; retries; swap/join prompt modes; and multi-speaker replies
  without another tool execution.
- Cache-key property tests vary owner, session, binding, history, timed state,
  locale, tokenizer, and policy version one field at a time and prove no stale
  hit crosses a changed dimension.
- Import preview tests modify or replace source bytes before commit and prove
  the preview token rejects the change without partial writes.
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
    expressionProfile: "task_preserving",
    bindingVersion: 7,
    detectedCardSpec: "v3",
    compilerAlgorithmVersion: 1,
    characterRevisionId: "uuid",
    personaRevisionId: "uuid-or-null",
    worldBookBindings: [{
      revisionId: "uuid",
      scope: "character"
    }],
    sceneId: null,
    semanticIndexVersion: "hash-or-null",
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
