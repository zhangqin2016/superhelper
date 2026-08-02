# Character Worlds - Development Handoff

Last updated: 2026-08-01 (Phase 2C complete)

## 0. STATE — READ FIRST

**Phase 2C is COMPLETE and committed.** All three tasks are implemented,
tested, and committed on `feat/opencode-engine`:

```text
bf6c7f1 test: gate agent draft and portability          (P2C-3)
42b9f4b feat: add character worlds workspace portability (P2C-2)
b82b81d feat: add agent character draft tool             (P2C-1)
```

- **P2C-1** — `lily_character_draft` broker tool (create/revise via the exact
  P2B-3 authoring service, `agent_draft` provenance, human-only activation,
  no binding-mutation path). Includes the approved safeStorage fix: the main
  process resolves owner scope + policy and injects
  `{ characterWorlds: { ownerScope, enabled } }` via
  `LILY_TOOL_BROKER_CONTEXT` (`assembleCharacterWorldsBrokerBlock` +
  `normalizeCharacterWorldsContext` in agent-draft-tools); subprocess trusts
  ONLY the context-channel block (absent → local Linux-dev derivation;
  malformed/disabled → fail closed); `LILY_CHARACTER_WORLDS=0` still wins
  (explicitly forwarded through the broker child env in mcp-config); injected
  owner drives the authoring service's internal re-resolution; payload cap
  aligned 4 MiB → 1 MiB with the IPC guard. Tests: 27 checks.
- **P2C-2** — `src/main/character-worlds/workspace-portability.js`: export
  collects ONLY entities referenced by session bindings + admitted turn
  snapshots (embedded world books, bounded `character-worlds.json` section,
  no account data/credentials/absolute paths/runtime events/session ids);
  import dedups by canonical hash, regenerates ids, remaps character→book
  pins, restores bindings only when their referenced revisions imported
  (`restoreBindingPreview`, `missing_revision` diagnostic). Integrated into
  workspace export/import (opt-in preview + pack section). Tests: 7 checks.
- **P2C-3** — capability gate extended (JSON + MD parity, registry green),
  stress mix adds `agent-draft` + `pack-roundtrip` ops with deterministic
  fingerprints (10_000 ops × 32 sessions × 2 runs), acceptance runbook
  checks 26–31 added.

Verified: `test-character-agent-draft` (27), `test-character-workspace-
portability` (7), broker suites, mcp-config, capability-gate, concurrency-
stress, architecture-boundaries (ratchets held), capability-gate-registry —
all green. `run-capability-gate` failure set is unchanged from the pre-2C
baseline (4 environment-only: test-tool-call-rescue pre-existing,
test-skill-catalog Node 24 `resourcesPath`, test-scroll-autofollow +
test-character-library need Electron).

Remaining (external / manual, not code):
- P2C-1 spec review + quality round 2 still NOT run (first attempt hit an API
  quota 403) — recommended before release.
- Manual acceptance matrix on macOS (arm64 + x64) and Windows x64, including
  real-hardware broker race tests (HANDOFF §7).

**Fix status — safeStorage under `ELECTRON_RUN_AS_NODE` (DONE, verified):**
Root cause: the stdio broker subprocess cannot decrypt (a) the remote-config
cache → policy always disabled on mac/win → tool dead in production; (b) the
account refreshToken → logged-in users fall back to device scope → drafts land
in an invisible owner namespace.

1. ✅ Main process resolves owner scope + policy (it CAN decrypt) and injects
   `{ characterWorlds: { ownerScope, enabled } }` into
   `LILY_TOOL_BROKER_CONTEXT` via session-runner-pool's sharedBrokerContext
   (`assembleCharacterWorldsBrokerBlock`). The subprocess treats ONLY
   context-channel values as authoritative (strict shape validation;absent → current local derivation as Linux-dev fallback).
   `LILY_CHARACTER_WORLDS=0` must still win over injected `enabled:true`
   (verify env inheritance; pass explicitly if the MCP env replaces).
2. Tests: encrypted-cache/account-state simulation; context assembly unit
   test; malformed injected values fail closed; kill switch e2e.
3. Align `MAX_DRAFT_PAYLOAD_BYTES` 4 MB → 1 MiB (match
   `ipc-character-authoring.js` so agent drafts stay human-editable).

Spec review of P2C-1 has NOT run yet (first attempt hit an API quota 403).
Remaining after the implemented fix: run BOTH reviews (spec + quality round 2),
then commit with message `feat: add agent character draft tool`, tick P2C-1
checkboxes, and continue with P2C-2 (workspace portability).

## 1. Current Task

**Character Worlds Phase 1, Phase 2A (World Book Activation) AND
Phase 2B (Native Authoring Foundation) are COMPLETE.**
All tasks are implemented, independently reviewed (specification + adversarial
code-quality, multi-round), and committed.

Plans (all checkboxes marked):

- Phase 1: `docs/superpowers/plans/2026-07-30-character-worlds-phase-1.md`
- Phase 2A: `docs/superpowers/plans/2026-07-31-character-worlds-phase-2.md`
- Phase 2B: `docs/superpowers/plans/2026-07-31-character-worlds-phase-2b.md`
- Phase 2C (IN PROGRESS):
  `docs/superpowers/plans/2026-07-31-character-worlds-phase-2c.md`
- Design source:
  `docs/superpowers/specs/2026-07-29-character-worlds-design.md`
- Acceptance runbook: `docs/character-worlds-phase-1-acceptance.md`
  (Phase 1 checks 1-15, Phase 2A checks 16-20, Phase 2B checks 21-25)

Workspace and branch:

```text
Workspace: /Users/zhangqin/aicode/ceshitermianl
Branch:    feat/opencode-engine
HEAD:      33f29e0 (docs: add character worlds phase 2c plan)
Base:      2314573
```

## 2. Task Status

### Phase 1 (complete)

| Task | Commit |
|---|---|
| 1. Persistence and immutable revisions | `9d9617d` |
| 2. Bounded JSON card parser | `a4778d5` |
| 3. PNG/APNG card import | `c005d2d` |
| 4. Safe deterministic macros | `897f58c` |
| 5. Preview, commit, export, worker and file broker | `ae14dab` |
| 6. Atomic per-turn binding snapshot and dispatch isolation | `f347b6a` |
| 7. Bounded lower-authority context compiler + injection | `ae973ab` |
| 8. IPC, preload and service lifecycle | `de39d86` |
| 9. Conversation-level renderer UI | `1045c65` |
| 10. Signed rollout policy and kill switch | `1ea5943` |
| 11. Capability Gate and release acceptance | `cdfea08` (+ `ebb2d66` registry parity) |

### Phase 2A — World Book Activation (complete)

| Task | Commit |
|---|---|
| WB-1. World-book persistence (schema v8) | `2d07dcb` |
| WB-2. Embedded character_book import (schema v9) | `9921735` |
| WB-3. Deterministic activation resolver | `1b2bb7c` |
| WB-4. Compiler envelope integration + timed checkpoints (schema v10) | `43c47cd` |
| WB-5. V3 decorator compilation | `78d579c` |
| WB-6. Read-only IPC + capability gate + acceptance | `25738d5` |

### Phase 2B — Native Authoring Foundation (complete)

| Task | Commit |
|---|---|
| P2B-1. Persona persistence (schema v11) | `1757eb3` |
| P2B-2. Persona binding + envelope (schema v12) | `db2f036` |
| P2B-3. Validated authoring domain APIs | `7bc87ed` |
| P2B-4. Authoring IPC + library management UI | `af15de6` |
| P2B-5. Switching timeline events + update-available | `e520de6` |
| P2B-6. Capability gate + acceptance extension | `e8a47e3` |

### Phase 2C — Agent Drafting + Workspace Portability (in progress)

| Task | Status |
|---|---|
| P2C-1. Agent character draft tool | Implemented, UNCOMMITTED, one fix batch pending (see §0) |
| P2C-2. Workspace package portability (§14.4) | Not started |
| P2C-3. Capability gate + acceptance extension | Not started |

P2C-1 what-exists-today (uncommitted): broker tool `lily_character_draft`
(create|revise for characters/personas) through the P2B-3 authoring service
with import-identical codes and executable-key screening; provenance
`source_kind = "agent_draft"`; no binding-mutation path (structural +
behavioral proof); available in the platformOnly production transport behind
the policy gate; lazy subprocess authoring via
`CharacterAuthoringService` over `MessageStore` (no eager worker pool; WAL
by design); renderer "agent draft" badge in library/history; tool
description tells the model approval is human-only.


### Phase 2A summary

- World-book entities with immutable revisions, mirroring the character
  discipline (owner-scoped, hash-deduped, additive migrations v8/v9/v10).
- V2/V3 embedded `character_book` imports in the same transaction as the
  character revision; executable-sounding keys stripped from canonical and
  reported `rejectedExecutable`; unknown fields inert.
- Pure deterministic resolver (`world-book-activation.js` et al.): Aho-Corasick
  multi-pattern index, NFC + locale-independent case handling, whole-word with
  CJK exemption, SHA-256 counter probability (seeded by
  owner/session/turn/revision/entry/phase), union-find inclusion groups with
  Fenwick weighted choice, bounded recursion, sticky/cooldown/delay by
  canonical message seq, complexity counters with coded budget errors
  (matching policy version `lily-world-book-match-1`).
- Envelope integration: §10.3.1 world buckets, `activatedWorldEntries`
  contract, `safe_behavior` for at_depth/outlet; resolver failure → character
  without world entries (§16), never fatal.
- Durable timed checkpoints (`world_book_checkpoints`), written only after
  successful turn finalization; rewind purges; corrupt rows self-heal;
  deterministic recompute replay semantics.
- CCV3 decorators compiled at revision build (typed AST, first-value rule,
  `@@@` chains depth 8, position>depth precedence, stateful match via
  checkpoint `matched` list); unknown/invalid inert + reported.
- Read-only IPC (`world-book:list/get/get-revision`); capability gate 66
  tests incl. 12 failure modes; stress 10k ops × 32 sessions deterministic.

### Phase 2B summary

- Persona entities/revisions (schema v11), narrative-only by construction
  (authorization-shaped keys rejected); binding gains an optional persona pin
  (schema v12, CAS, admission snapshot, retry/recovery/steer inheritance);
  persona narrative compiles into the §10.3.1 slot below character identity,
  fail-open to compile-without-persona (§16).
- One validated authoring API (`authoring-service.js`) for
  create/edit/history/restore/duplicate/archive/delete across characters,
  personas and world books — import-identical validation (executable keys
  screened), immutable revisions with parent pins, reference-probed
  delete-as-archive (§18), coded errors only.
- Guarded authoring IPC (15 channels, shared `ipc-character-guards.js`) and
  the library manager UI (tabs for characters/personas/books, search/tag
  filter, edit with explicit revision, history + restore, duplicate, archive,
  export, import report) with dirty-form protection and full a11y/i18n.
- Durable switch events surface as timeline notices (renderer-side projection
  from `getBindingEvents` with an event cursor, capped window); editing an
  active character/persona surfaces "update available" with a fresh-CAS apply
  flow; no greeting injection (§8).
- Capability gate 72 tests incl. 15 failure modes + authoring-isolation proof;
  compiler zero-keep candidates no longer cascade-omit lower-priority content
  (§10.3 greedy packing).

## 3. Remaining Work

### Manual acceptance (blocks release enablement)

- Runbook checks 1-15 (Phase 1), 16-20 (Phase 2A) and 21-25 (Phase 2B) on
  macOS arm64/x64 and Windows x64 with recorded evidence. Record 1 (macOS
  arm64 automated gates + launch smoke) is filed; manual UI rows are OPEN.
- Windows broker race testing on real hardware/VM.

### Phase 2C candidates (not started)

- Natural-language draft creation by the agent through the validated
  authoring API (§13.2 — the API is ready; agent wiring + approval flow).
- Workspace-package portability (§14.4).

### Phase 3 candidates (spec "Depth")

- Scene state and per-character episodic memory (§11).
- Group/story modes (§12) and side-effect-safe response variants.
- Optional local semantic retrieval enhancement (§10.4).
- Regex activation keys through a bounded linear-time/isolated path
  (currently inert + reported, fail closed).
- Chat-linked and profile-global books; `greetingIndex` plumbing for
  `@@is_greeting`.

## 4. Known Issues / Follow-ups (non-blocking)

- Registry parity is one-directional (JSON ⊆ MD); set-equality check would
  close the remaining drift hole.
- Import sources must live under the user's home directory (fail closed).
- ZWJ emoji sequences degrade in compiled context (Cf-stripping tradeoff).
- `world-book:list` N+1 revision reads; fine at expected scale.
- `@@activate_only_after` gates on total canonical sequence (documented proxy
  for CCV3 "Nth user input").
- Known environmental failure `PLAYWRIGHT_NODE_MISSING` (worktree bundle).
- Session deletion leaves orphaned checkpoint rows (unreachable; rewind purge
  covers the user-visible path).

## 5. Why It Is Designed This Way

### Local-first, owner-scoped and immutable

Character and world-book data stays in the local MessageStore. Revisions are
immutable so a queued or recovered turn refers to one exact state. Owner scope
is main-process-derived; renderer/mobile payloads cannot select an owner.

### Admission is the linearization point

A turn snapshots its binding inside the admission transaction. Binding changes
after admission affect only later turns. Retries, recovery and steer inherit
by trusted source turn ID; the world-book resolver sees only the admitted
immutable revision and the pre-turn durable checkpoint.

### Dispatch is linearized against principal switches

Queue dispatches pin (session, turn, item, owner, epoch) and revalidate inside
a synchronous gate before the claim CAS and engine call. A paused turn keeps
its durable `admitted` row and revives exactly once; the pause is projected
with the non-terminal `turn.paused` event.

### At-most-once is preferred over unsafe replay

Once a turn enters `dispatching`, a crash makes the engine outcome uncertain.
Outcome-unknown work is never auto-replayed.

### Imported behavior has lower authority

Unknown data is preserved inertly. Executable extensions never run. Macros are
deterministic and bounded. Character and world-book context compiles into a
bounded, separately fingerprinted system suffix below Lily's protected
guidance; it never displaces Lily identity, tools, evidence, or user history.
World entries are activation-resolved declaratively; regex keys stay inert
until a bounded engine exists.

### Fail open only to Lily's existing strong default

Any Character Worlds failure (disabled policy, missing binding/revision/book,
parser/macro/compiler/resolver error, over budget, provider unsupported)
produces a byte-equivalent native turn, or — when a character is bound but
only its book fails — the same character compiled without world entries (§16).
Security ambiguity, owner ambiguity and outcome-unknown dispatches fail closed.

## 6. Do Not Change

1. Do not weaken or bypass `CAPABILITY-GATE.md`.
2. Do not make imported scripts, plugins, regex scripts, unknown macros, or
   decorator text executable.
3. Do not trust renderer/mobile `ownerScope`, raw snapshots, destination paths or
   compatibility profiles.
4. Do not reread the latest character binding during retry, recovery, queue
   promotion or steer — and never resolve a world book by its current entity
   state instead of the pinned `characterBookRevisionId`.
5. Do not auto-replay `dispatching`, `promoted`, `accepted` or
   `outcome_unknown` turns.
6. Do not replace a durable CAS with an in-memory check.
7. Do not reintroduce a global single-task lock. Isolation is per session/owner.
8. Do not remove the worker/broker/resolver timeout, cancellation, resource,
   complexity and memory bounds.
9. Do not edit vendored `anthropics-*` skills.
10. Do not modify or commit generated runtime data.
11. Do not stage these worktree-only links:

```text
bundles/darwin-arm64
bundles/darwin-x64
bundles/win32-x64
generated-assets
```

12. Do not signal a resumable pause with a terminal event type — use
    `turn.paused`.
13. Do not perform dispatch claims or engine sends outside the
    `_withDispatchLinearization` gate; never dispatch re-entrantly from inside
    a gate action.
14. No remote policy field may enable the feature loosely: strict
    `enabled === true`, validated profile, `LILY_CHARACTER_WORLDS=0` wins.
15. Do not concatenate character/world context into user text, file parts, or
    persisted history — it rides only the dedicated system suffix.
16. Do not persist world-book checkpoints for failed/interrupted/
    outcome-unknown turns; rewind must purge them.

## 7. Verification Commands

```bash
PATH=/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH

# Capability gate (66 tests)
node scripts/run-capability-gate.mjs

# Full suite
node scripts/run-all-tests.mjs

# World-book suites
node scripts/test-character-world-book-store.mjs
node scripts/test-character-world-book-import.mjs
node scripts/test-character-world-book-activation.mjs
node scripts/test-character-world-book-compile.mjs
node scripts/test-character-world-book-decorators.mjs
node scripts/test-character-world-book-ipc.mjs

# Phase 1 focused matrix: see docs/character-worlds-phase-1-acceptance.md
```
