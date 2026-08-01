# Character Worlds Phase 2C: Agent Drafting + Workspace Portability

Date: 2026-07-31
Status: In progress
Design source: `docs/superpowers/specs/2026-07-29-character-worlds-design.md`
  (§13.2 natural-language creation, §14.4 portability, §14.5 performance,
  §15 IPC, §8 binding approval semantics)
Builds on: Phase 1, Phase 2A, Phase 2B (all complete through `e8a47e3`).

## Scope

Phase 2C completes the spec's Phase 2 ("Native authoring"):

1. **Agent-drafted characters**: the agent (during a normal turn) can create
   or revise characters/personas through the SAME validated authoring API
   (P2B-3) via a narrow broker tool. Nothing the agent writes ever becomes
   active by itself: drafts carry explicit agent provenance, and activation
   requires the existing human approval paths (session select / library
   review / update-available apply), per §13.2 and §8.
2. **Workspace portability (§14.4)**: the existing reviewed
   workspace-export/import flows gain an explicit, previewed Character
   Worlds opt-in — referenced revisions only, new local IDs with remapped
   references, hostile import pipeline for all content, bindings restored
   only when their referenced revisions imported successfully.

Explicitly OUT: scene state, episodic memory, group/story modes, response
variants, semantic retrieval, bounded regex engine (Phase 3); model-assisted
memory maintenance (§14.5, Phase 3).

## Invariants

1. The agent never binds, selects, or activates anything. Drafts are
   inert data with `agent_draft` provenance until a human approves through
   the existing UI flows.
2. The draft tool validates through the exact P2B-3 authoring service —
   identical codes, identical limits, executable keys screened.
3. The tool is capability-gated: unavailable when Character Worlds is
   disabled by policy/kill switch, and absent from the model's tool list in
   native mode.
4. Export never silently includes private characters/personas/worlds —
   explicit opt-in with a preview listing every included entity and asset;
   no account data, credentials, absolute local paths, runtime events, or
   unrelated library entries (§14.4).
5. Import remaps every entity to new local IDs and re-pins internal
   references (character→book, binding→revision) transactionally; content
   passes the same hostile pipeline as file import.
6. Bindings restore only when their referenced revisions imported;
   otherwise the conversation opens in native Lily with a diagnostic.
7. Native turns stay byte-equivalent; `CAPABILITY-GATE.md` only strengthened.

## Task P2C-1: Agent Character Draft Tool

**Files:**
- Create: `src/main/character-worlds/agent-draft-tools.js`
- Modify: `src/main/mcp/tool-broker-registry.js` (or the registry's tool
  source — investigate `buildBrokerTools`)
- Modify: `src/renderer/modules/character-library*.js` (provenance badge)
- Create: `scripts/test-character-agent-draft.mjs`

- [ ] **Step 1: Write failing tests**
  Broker tool `lily_character_draft` with actions `create` and `revise`:
  validated through the authoring service (identical rejection codes for
  hostile input); provenance records `{kind:"created", format:"lily",
  draftedBy: "agent"}` (or an `agent_draft` source kind — decide and
  document); revise requires explicit entity id + expectedBaseRevisionId
  (CAS); the tool CANNOT call set-binding (no binding mutation path exists
  through it — assert structurally); unavailable → clean coded error when
  policy/kill switch disables the feature; absent from the tool list when
  disabled/native; bounded args (payload caps, id formats); results are
  metadata-only (entityId/revisionId/revisionNumber — never canonical echo).
- [ ] **Step 2: Run tests, verify they fail**
- [ ] **Step 3: Implement the broker tool**
  `agent-draft-tools.js` builds the tool definition + handler against
  `CharacterWorldsService.authoring`; register in the broker registry behind
  the policy gate (fail closed); the tool's description tells the model to
  ask the user to review/select in the library (approval is human-only).
- [ ] **Step 4: Surface agent provenance**
  Library rows show a small "agent draft" badge for agent-provenance
  revisions (i18n ×3); no auto-activation anywhere (audit: no call path
  from the tool to set-binding or update-apply).
- [ ] **Step 5: Run tool + broker + capability regressions**
- [ ] **Step 6: Commit** — `feat: add agent character draft tool`

## Task P2C-2: Workspace Package Portability

**Files:**
- Modify: `src/main/ipc-workspace-export.js` (+ its planner/service)
- Modify: `src/main/workspace-import-service.js`
- Create: `src/main/character-worlds/workspace-portability.js`
- Create: `scripts/test-character-workspace-portability.mjs`

- [ ] **Step 1: Write failing portability tests**
  Export with `includeCharacterWorlds: true`: the preview lists every
  included entity + asset (characters/personas/books referenced by the
  exported sessions' bindings + admitted turn snapshots); ONLY referenced
  revisions are packed; no account data, credentials, absolute paths,
  runtime events, or unrelated library entries; opt-out default packs
  nothing. Import: entities get new local IDs; character→book pins remapped;
  session bindings restored only when their referenced revisions imported
  (otherwise native + diagnostic); executable/unknown fields survive inert
  through the same pipeline; exact-duplicate re-import dedups naturally.
- [ ] **Step 2: Run tests, verify they fail**
- [ ] **Step 3: Implement export-side packing**
  `workspace-portability.js`: collect referenced revision ids from the
  exported sessions (current bindings + durable turn snapshots), emit a
  bounded `character-worlds.json` pack section with canonical revisions +
  asset blob references; extend the export preview manifest.
- [ ] **Step 4: Implement import-side remap**
  Transactional import: new entity ids per imported entity, revision ids
  regenerated with provenance `{kind:"imported", format:"workspace_package",
  container:"zip"}`, internal references remapped (character book pins,
  persona/character binding pins), through the existing validation models;
  binding restoration per rule 6.
- [ ] **Step 5: Run portability + workspace flow regressions**
- [ ] **Step 6: Commit** — `feat: add character worlds workspace portability`

## Task P2C-3: Capability Gate + Acceptance Extension

**Files:**
- Modify: `src/shared/capability-gates.json`, `CAPABILITY-GATE.md`
- Modify: `scripts/test-character-worlds-capability-gate.mjs`
- Modify: `scripts/test-character-worlds-concurrency-stress.mjs`
- Modify: `docs/character-worlds-phase-1-acceptance.md`

- [ ] **Step 1: Extend the gate**
  Agent draft failure modes (tool disabled, hostile draft input) → no
  durable write + native turn byte-equivalence; portability failure modes
  (missing referenced revision, hostile pack) → native conversation +
  diagnostic, never a half-imported library; guards registered (JSON + MD
  parity).
- [ ] **Step 2: Extend the stress mix**
  Agent draft create/revise ops and pack export/import remap round-trips
  with deterministic fingerprints.
- [ ] **Step 3: Extend the acceptance runbook**
  Phase 2C manual checks (agent draft → human approve → active; library
  badge; export opt-in preview; import remap + binding restore; native
  fallback on missing referenced revision; kill switch covers the tool).
- [ ] **Step 4: Run the full matrix**
- [ ] **Step 5: Commit** — `test: gate agent draft and portability`

## Phase 2C Exit Criteria

- The agent can draft characters/personas through one validated tool; drafts
  never self-activate; human approval paths are unchanged and exclusive.
- Workspace packages carry Character Worlds data only by explicit opt-in
  with a complete preview; import remaps ids and references transactionally
  and restores bindings only when their revisions imported.
- Native turns stay byte-equivalent; every new failure mode degrades per §16.
- Capability gate, stress, and runbook cover the new paths.
