# Character Worlds Unified Experience Design

**Status:** Approved product direction; core implementation delivered (2026-08-03); release verification pending

**Date:** 2026-08-02

**Scope:** Character cards, user personas, and world books in Lily Workbench

Core implementation is present in the current branch, including the production
library, natural-language authoring flow, explicit activation, immutable
runtime admission, and composer-level context visibility. Remaining release
work is recorded in `docs/character-worlds-gap-trace.md`, including the
delete/archive product decision, model evaluation, and real-device/manual
acceptance.

## 1. Objective

Make Character Worlds usable by a non-technical user through ordinary language,
without weakening Lily's existing agent, model, tool, file, permission, memory, or
automation capabilities.

The user should be able to say what they want, let Lily create a high-quality
artifact, try it in the current conversation, request changes naturally, and
activate it only after they are satisfied. A successful creation must be a real,
durable Character Worlds entity. Markdown, JSON, or workspace files never count as
saved entities.

## 2. Product Model

Character Worlds has three independent, composable facets:

| Facet | User meaning | Runtime responsibility |
| --- | --- | --- |
| Character card | Who is speaking to me? | Assistant identity, personality, voice, boundaries, opening behavior |
| Persona | Who am I in this conversation? | User identity and narrative context, never account or authorization state |
| World book | What facts and rules are true? | Bounded lore, terminology, relationships, and deterministic trigger rules |

The native Lily assistant is represented by no selected character revision. It is
not represented by an empty Character Worlds configuration. A native Lily
conversation may still use a persona, one or more world books, or both.

All three facets are optional. Selecting any facet affects future admitted turns
only. Existing messages and admitted/retried/recovered turns retain their exact
historical snapshots.

## 3. Product Principles

1. **Natural language first.** Creation and revision begin as a conversation with
   Lily. The library is for browsing, history, import, and advanced inspection; it
   is not a required schema form.
2. **AI completes the design.** Lily asks only when a missing decision would
   materially change the result. It fills in coherent details and checks the whole
   artifact before saving.
3. **Creation is not activation.** A new revision is inert until the user previews
   or explicitly activates it.
4. **Preview is real but reversible.** Preview uses the same compiler and turn
   admission path as activation, but does not mutate the durable binding.
5. **Every state change is host-owned.** The main process derives owner and
   conversation scope, validates references, applies CAS, and persists state. The
   model and renderer cannot invent trusted identifiers.
6. **Revisions are immutable.** Refinement creates a new revision. It never edits
   history in place and never silently updates a durable binding.
7. **Capability parity is mandatory.** Character expression is lower-authority
   context. It cannot remove tools, change permission mode, select a weaker model,
   alter file handling, or override protected Lily instructions.
8. **Failure is honest and bounded.** Failure never becomes a fake success, a
   hanging turn, repeated uncontrolled retries, or a Markdown substitute.

## 4. Unified User Journey

### 4.1 Create

The user can start from chat or choose `Let Lily design` in the corresponding
library area. Example requests include:

- "Create a warm, playful girlfriend who likes to tease me but respects my work."
- "Set me up as the product lead of this project and remember how I make decisions."
- "Create a cyberpunk world book with corporate factions and rules for neural tech."

Lily identifies the requested facet, asks at most the focused questions needed to
avoid a materially wrong result, designs the complete artifact, and calls
`lily_character_draft`. The turn is not complete until that required tool returns
`ok: true`, or the bounded repair path ends with an explicit not-saved result.

### 4.2 Receive a Result

After a successful tool call, the host creates a durable, host-owned
`character_worlds_receipt` turn artifact. The renderer builds the result card from
this receipt, not from model prose or parsed Markdown.

Every card shows:

- Artifact type and display name
- A short human-readable summary
- Whether it is a draft, previewed revision, or active revision
- Trusted provenance when applicable, such as official or imported
- Clear actions, without exposing internal entity or revision IDs

Actions are facet-specific:

| Facet | Primary actions |
| --- | --- |
| Character | `Try chat`, `Use in this conversation`, `Adjust`, `View character` |
| Persona | `Try this persona`, `Use in this conversation`, `Adjust`, `View persona` |
| World book | `Test in this conversation`, `Add to this conversation`, `Adjust`, `View entries` |

The cards use existing icon controls and tooltips where an icon is not self-evident.
They are not nested inside another decorative card.

### 4.3 Preview in the Current Conversation

Preview is a per-owner, per-conversation provisional overlay. It is persisted so a
renderer reload or application restart does not silently lose the user's trial,
but it never changes the durable binding.

Starting a preview affects only the selected facet:

- A character preview temporarily replaces the effective character.
- A persona preview temporarily replaces the effective persona.
- A world-book preview temporarily adds that book to the effective book set.

If the same world-book entity is already active at another revision, preview
replaces that entity's effective revision instead of adding a duplicate.

The other durable or previewed facets remain in place. This allows the user to test
one artifact alone or compose all three.

While preview is active, a compact conversation banner states what is being tried
and offers `Use`, `Adjust`, and `Exit preview`. The banner is the only persistent UI
addition; creation and refinement remain natural-language workflows.

Preview has no silent TTL. It remains active until the user exits it, activates the
artifact, or removes the corresponding facet. This makes restart behavior
deterministic and avoids a character changing in the middle of a conversation.

For world books, test mode may show which entry titles were activated and a brief
trigger reason after a turn. It must not expose hidden system prompts, protected
instructions, or private raw context.

### 4.4 Refine Naturally

`Adjust` focuses the composer with a plain-language invitation. The associated
receipt supplies an opaque action token. Main resolves that token to the exact
owner, entity, and expected base revision; renderer text is never trusted as the
revision target.

Requests such as "less clingy", "make my persona more decisive", or "neural tech
should be illegal outside hospitals" create a new immutable revision through the
same required tool path.

If the adjusted artifact is currently in preview, the successful refinement may
atomically move that preview to the new revision because the user explicitly
requested the change from that preview. The UI reports the change. A durable
binding never follows a new revision automatically; it shows `Update available`
and requires an explicit apply action.

Concurrent edits use an expected base revision. A conflict preserves both existing
revisions, refreshes the visible state, and asks the user to reapply the intended
change. It never overwrites another conversation or device's revision.

### 4.5 Activate

Activation updates only the selected facet using compare-and-swap on the current
conversation configuration. When activating an artifact that is in preview, the
durable update and preview removal occur in the same SQLite transaction. A crash
therefore leaves either the complete old state or the complete activated state,
never an ambiguous mixture.

The effective durable configuration is:

```text
ConversationCharacterConfig
  characterRevisionId: string | null
  personaRevisionId: string | null
  worldBookRevisionIds: string[]
  worldBookMergeStrategy: deterministic enum
  greetingIndex: number | null
  sceneId: string | null
  groupId: string | null
  bindingVersion: integer
```

`characterRevisionId: null` means native Lily. Persona and world-book fields remain
valid in that state. Greeting, scene, and group fields apply only when their
required character configuration is valid.

Adding a world book appends its pinned revision once; it does not duplicate it or
replace other books. Removing and reordering books are explicit operations. The
existing deterministic merge strategy remains the authority for conflicts.

## 5. Architecture

### 5.1 Host-Owned Receipt Service

The receipt service converts a successful Character Worlds tool result into a
versioned turn artifact with only renderer-safe fields and opaque action tokens.
It is responsible for:

- Verifying the tool call belongs to the admitted turn and owner
- Verifying the referenced immutable revision exists and matches the facet
- Persisting the receipt with the turn result
- Issuing short-lived, single-purpose action tokens for a persisted receipt
- Resolving actions in main without trusting model text or renderer IDs

A receipt is evidence of persistence, not activation. Its safe display fields and
trusted references remain durable with the turn. When an old result card is
rendered, renderer requests fresh action tokens from main; tokens themselves are
not persisted in message content.

### 5.2 Preview Service

The preview service owns provisional conversation overlays. Each record includes:

- Owner and conversation scope derived in main
- Exact pinned revision IDs for each previewed facet
- Preview version for CAS
- Active or cleared status
- Created and updated timestamps

The service exposes facet-level start, replace, remove, read, and clear operations.
It does not compile prompts and cannot change the durable binding.

### 5.3 Conversation Configuration Service

The binding service evolves from character-coupled mode selection to independent
facet composition. It remains the only writer for durable conversation
configuration and immutable revision pins.

Existing bindings migrate additively:

- Existing native bindings become `characterRevisionId: null` with no other
  facets changed.
- Existing character bindings retain their character, persona, world books,
  greeting, scene, and group selections.
- Invalid legacy references are dropped independently while every valid facet is
  preserved. An invalid character falls back to native Lily; dependent greeting,
  scene, and group selections are cleared. A local diagnostic is emitted and
  stored entities are never deleted.

### 5.4 Turn Admission and Runtime Compilation

Turn admission atomically snapshots:

1. The durable conversation configuration
2. The active preview overlay
3. The resulting effective exact revision pins

Retries, steering, scheduled messages, recovery, and queued turns inherit the
trusted admitted snapshot. They never reread whichever preview or binding happens
to be current later.

The existing Character Worlds compiler consumes only this effective snapshot. A
preview therefore exercises the same runtime behavior as activation. Compiled
content remains a bounded, lower-authority suffix after protected Lily guidance.

### 5.5 Renderer Surfaces

Renderer responsibilities are intentionally narrow:

- Render trusted receipts as result cards
- Render current durable and preview state
- Send opaque action tokens and natural-language requests
- Explain the three concepts in ordinary language:
  - Character: who is speaking to you
  - Persona: who you are here
  - World book: the facts and rules of this world

Renderer cannot persist entities, compose system prompts, choose owner scope, or
activate a raw revision ID.

## 6. Data and Authority Boundaries

- Owner identity, conversation identity, and workspace scope come from main.
- Entity definitions and revisions remain local-first and owner-scoped.
- Character, persona, and world-book content is data, never executable code.
- Imported scripts, regex scripts, plugins, unknown macros, and embedded commands
  remain inert.
- Persona fields cannot represent account identity, permissions, credentials, or
  authorization decisions.
- World-book and character text cannot grant tools, widen permissions, change the
  model, override Lily policy, or issue trusted operational commands.
- Receipts and exports omit secrets, absolute local paths, protected prompt text,
  and authentication data.
- Every mutation is scoped by owner plus conversation or entity and guarded by CAS.
- Two conversations may preview or activate different revisions concurrently with
  no shared mutable runtime state.

## 7. Failure and Recovery

| Failure | Required behavior |
| --- | --- |
| Character Worlds tool unavailable | End bounded retries, state that the entity was not saved, preserve native Lily behavior |
| Tool returns malformed or hostile output | Reject receipt creation; do not display success or trust supplied ownership/IDs |
| Draft validation fails | Perform bounded targeted repair; otherwise report the exact validation blocker |
| Preview revision is missing or corrupt | Ignore that preview override, use the same facet from the durable configuration, and show one actionable diagnostic |
| Preview compiler fails or exceeds budget | Use the durable configuration for that facet in the same dispatch; do not remove tools or issue a second model dispatch |
| Activation CAS conflict | Refresh configuration and require explicit reapply; never overwrite newer state |
| Crash during activation | The SQLite transaction leaves either the complete old state or the complete activated state with preview cleared |
| Renderer reloads | Restore persisted preview and receipt actions from main-owned state |
| Provider lacks safe system context | Preserve the existing byte-equivalent native dispatch |

The model does not repeatedly call unavailable tools. The host completion gate is
responsible for one bounded correction path and a final truthful result.

## 8. UX Details

- New conversations start with native Lily unless the user explicitly chooses to
  carry a configuration into them.
- Switching, previewing, or activating in a long conversation changes future turns
  only. History is never rewritten or reinterpreted.
- The library opens directly to useful artifacts, revisions, and management
  actions. Manual full-schema editing remains an advanced edit surface, not the
  primary creation journey.
- Official starter artifacts are visibly trusted through host-owned provenance;
  names or editable tags cannot impersonate official status.
- Empty, loading, unavailable, conflict, and update-available states have explicit
  copy and recovery actions.
- Controls remain compact and stable across desktop sizes. Text does not depend on
  viewport-scaled font sizes and does not overlap at translated lengths.

## 9. Observability and Privacy

Local structured events cover:

- Draft created or creation failed
- Receipt emitted or rejected
- Preview started, changed, exited, or recovered
- Activation attempted, succeeded, or conflicted
- Runtime facet omitted by a fail-open path

Diagnostics use local opaque IDs, revision hashes, reason codes, and timings. Any
product analytics must contain no character prose, persona content, world-book
entries, chat text, local paths, or prompt bodies.

## 10. Verification Strategy

### 10.1 Contract and Persistence Tests

- Successful tool result creates one durable, renderer-safe receipt.
- Failed or forged output creates no receipt and no success card.
- Preview records survive restart and remain owner/conversation isolated.
- Activation and preview clearing are atomic in one SQLite transaction.
- Legacy bindings migrate without losing selected revisions.
- All create, revise, restore, activate, and preview mutations enforce CAS.

### 10.2 Composition Matrix

Verify all supported future-turn combinations:

- Native Lily alone
- Native Lily plus persona
- Native Lily plus one or multiple world books
- Native Lily plus persona and world books
- Character alone
- Character plus persona
- Character plus world books
- Character plus persona and world books
- Any durable combination with one or more preview facet overrides

For every combination, assert unchanged model selection, tools, skill IDs,
permission mode, attachments, evidence context, subagent surface, user text, and
output reserve.

### 10.3 Lifecycle and Concurrency Tests

- Create, preview, adjust, preview new revision, activate, and exit preview.
- Two conversations preview different revisions concurrently without leakage.
- Two owners use the same local installation without leakage.
- Busy conversations queue scheduled messages against their admitted snapshot;
  other conversations continue independently.
- Retry, steer, recovery, compaction, and rewind retain or purge the correct exact
  snapshots and timed world-book checkpoints.
- Concurrent revision and activation conflicts never lose data.
- A restart at every state boundary resumes to one deterministic state.

### 10.4 Runtime and Security Tests

- Character Worlds remains lower authority than Lily and cannot grant tools or
  permissions.
- Hostile imports, macros, scripts, oversized definitions, and forged action tokens
  are inert or rejected.
- Missing/corrupt/over-budget facets fail open independently.
- Native turns remain byte-equivalent when the feature is disabled or unused.
- World-book test diagnostics expose entry titles/reasons only, never prompt text.
- Fuzz tests cover receipt payloads, imported artifacts, trigger rules, and action
  tokens.

### 10.5 UI and End-to-End Acceptance

Automated Electron renderer tests and live macOS/Windows smoke tests cover:

1. Create a playful girlfriend character, try a chat, request a less clingy
   revision, and activate it.
2. Create a product-lead persona and use it with native Lily.
3. Create a cyberpunk world book, test its triggers, and add it to the conversation.
4. Combine all three facets and verify each contributes only its intended context.
5. Open two conversations with different previews and confirm no state crosses.
6. Restart during preview and confirm the banner and exact revision return.
7. Disable Character Worlds and confirm the same native agent capabilities remain.
8. Make the tool unavailable and confirm one truthful not-saved outcome without a
   hang or Markdown fallback.

A model-evaluation suite grades natural-language results for coherence,
specificity, voice consistency, boundary quality, self-consistency, useful first
interaction, and correct use of uncertainty. Deterministic code, not the model,
grades persistence, isolation, activation, and security.

## 11. Rollout

1. Add schema and services behind independent kill switches for receipts, preview,
   and composable conversation configuration.
2. Migrate and read old bindings before enabling new writes.
3. Enable internal receipt rendering while activation still uses the existing path.
4. Enable preview for one facet, then the full composition matrix.
5. Enable independent persona and world-book activation with native Lily.
6. Run the full capability gate, unit/renderer/runtime suites, concurrency stress,
   and packaged-app smoke tests before production rollout.
7. Roll out gradually using metadata-only health signals. Any failing slice falls
   back to the existing native or durable-binding behavior without deleting data.

## 12. Non-Goals

- No automatic activation without explicit user action.
- No separate trial conversation; preview occurs in the current conversation.
- No cloud upload or cross-account sharing by default.
- No marketplace, autonomous character growth, fine-tuning, or training system in
  this implementation.
- No destructive revision deletion.
- No mandatory manual schema wizard.
- No change to model, tool, permission, file, automation, or agent authority based
  on character expression.

## 13. Definition of Done

The feature is complete only when a user can create, preview, refine, and activate
each facet through natural language; native Lily can independently compose persona
and world books; all states survive restart; concurrent owners and conversations
remain isolated; failures are truthful and bounded; and the complete capability
gate proves that Lily is never less capable when Character Worlds is selected,
unused, disabled, malformed, or unavailable.
