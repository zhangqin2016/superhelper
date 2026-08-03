# Production Character Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the narrow character-library list with a production-grade grouped grid and detail workflow for characters, personas, and world books, and ship a professional Chinese enterprise legal-counsel role alongside the official productivity catalog.

**Architecture:** Keep repository and canonical revision data as the source of truth. Add a pure renderer presentation model that normalizes official and local summaries, derives groups and filters, and separates selection from activation. Use a guarded main-process activation endpoint with session-owner resolution and compare-and-swap semantics for the explicit “use in this conversation” action; all existing authoring and fail-open behavior remains intact.

**Tech Stack:** Electron renderer modules, vanilla DOM helpers, existing character-worlds IPC/repositories, JSON locale files, Node/MJS and Electron regression tests, CSS media queries.

## Delivery Status (2026-08-03)

Tasks 1-6 and the feature-owned portions of Task 7 are implemented: the
presentation model, official catalog, safe IPC summaries, atomic activation,
grouped responsive grid, detail workflow, persona/world-book safety metadata,
three-locale coverage, scale fixtures, accessibility assertions, and Electron
regression are all in the current branch. The full repository suite still has
environmental failures outside this feature (sandboxed loopback listeners,
LibreOffice, and Electron startup without the escalated test command); those
are recorded in the release verification rather than being marked as feature
successes.

---

## File Map

### Presentation and renderer state

- Modify `src/renderer/modules/character-library-model.js` — normalized summary types, group derivation, query/filter/sort, selected-detail and activation state transitions.
- Modify `src/renderer/modules/character-library-actions.js` — summary loading, detail loading, explicit activation, and legacy mutation operations routed through the new selection state.
- Modify `src/renderer/modules/character-library-view.js` — left group rail, responsive grid cards, details drawer, domain-specific details, action menu, empty/error/loading states.
- Modify `src/renderer/modules/character-library.js` — event wiring, active-session lookup, focus restoration, activation refresh, and compatibility with the existing edit/history/dirty-form behavior.
- Modify `src/renderer/index.html` — add semantic group rail, catalog toolbar metadata, and detail-drawer hosts while preserving the existing modal/dialog IDs used by tests and integrations.
- Modify `src/renderer/styles/character-library.css` — three-pane shell, stable grid cards, responsive breakpoints, drawer states, keyboard focus states, RTL logical properties, and reduced-motion behavior.
- Modify `src/renderer/i18n/locales/zh-CN.json`, `src/renderer/i18n/locales/en.json`, and `src/renderer/i18n/locales/ar.json` — all new labels, role metadata, status text, errors, group names, and accessibility labels.

### Official data and activation bridge

- Modify `src/main/character-worlds/official-character-catalog.js` — structured official metadata, 18 localized productivity-first roles, the China enterprise legal-counsel contract, and non-factual persona/world-book templates if catalog storage is kept in this module.
- Modify `src/main/official-character-ipc.js` — expose safe official metadata fields in list responses without exposing raw canonical instructions through summary IPC.
- Modify `src/main/ipc-character-worlds.js` — add a guarded library activation handler that validates owner, revision, scope, and binding version before committing a character/persona/world-book selection.
- Modify `src/preload.js` — expose only the whitelisted `activateLibraryItem` payload and response.
- Reuse `src/main/character-worlds/conversation-config.js`, `src/main/character-worlds/conversation-config-repository.js`, and existing repository CAS methods; do not introduce a second binding store.

### Tests and gate

- Modify `scripts/test-character-library-model.mjs` or create it if absent — pure model coverage for normalization, groups, filtering, ordering, and state transitions.
- Modify `scripts/test-official-character-catalog.mjs` — 18-role schema, complete localization, professional-contract invariants, and legal-role safeguards.
- Modify `scripts/test-character-library.cjs` — Electron DOM workflow, cards, drawer, activation, mutations, focus, responsive class/state behavior, and fallback paths.
- Modify or create `scripts/test-character-library-activation.mjs` — main-process owner/CAS/policy/revision validation for explicit activation.
- Modify `CAPABILITY-GATE.md` — register the grouped-library fallback and official-role contract guard in a separate hunk from unrelated worktree edits.

Existing uncommitted files unrelated to this feature must remain unstaged and untouched: `scripts/test-character-context-injection.mjs`, any character session-control changes, generated output, and `.superpowers` brainstorming artifacts.

## Task 1: Lock the pure presentation model

**Files:**
- Modify: `src/renderer/modules/character-library-model.js`
- Create or modify: `scripts/test-character-library-model.mjs`

- [ ] **Step 1: Write failing normalization and grouping tests.**

Add fixtures for one official character, one local character, one persona, one world book, one archived row, and one malformed legacy row. Assert that `normalizeLibraryItem` returns only bounded presentation fields, that missing category becomes `uncategorized`, and that `deriveLibraryGroups` produces deterministic counts without hiding malformed legacy data.

The test contract is:

```js
const item = normalizeLibraryItem("characters", {
  id: "official:product-manager",
  name: "资深产品经理",
  summary: "把需求变成可验收方案",
  categoryId: "work-delivery",
  source: "official",
  tags: ["需求", "PRD", "验收"],
});
assert.deepEqual(item.categoryId, "work-delivery");
assert.equal(item.source, "official");
assert.deepEqual(deriveLibraryGroups("characters", [item]).map((g) => g.id), [
  "all", "official", "work-delivery", "my", "recent", "archived",
]);
```

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `node scripts/test-character-library-model.mjs`

Expected: FAIL because the new pure exports and normalized state fields do not exist yet.

- [ ] **Step 3: Implement bounded pure helpers.**

Add and export:

```js
export const LIBRARY_GROUPS = Object.freeze({
  all: { id: "all", kind: "all" },
  official: { id: "official", kind: "source" },
  my: { id: "my", kind: "source" },
  recent: { id: "recent", kind: "recent" },
  archived: { id: "archived", kind: "archived" },
});

export function normalizeLibraryItem(tab, raw) { /* bounded presentation mapping */ }
export function deriveLibraryGroups(tab, items) { /* stable groups + counts */ }
export function filterLibraryItems(items, options) { /* query, group, tags, source */ }
export function sortLibraryItems(items, { now } = {}) { /* recent, editorial, name */ }
export function selectLibraryItem(state, id) { /* detail selection only */ }
```

Keep `sanitizeItems` as a compatibility wrapper or route it through
`normalizeLibraryItem`. Unknown optional metadata must be dropped from the
presentation object, never interpreted as instructions.

- [ ] **Step 4: Extend the reducer without changing existing form semantics.**

Add `groupId`, `selectedItemId`, `detail`, `detailLoading`, and `activation` to
the initial state. Add reducer actions `group.changed`, `detail.selected`,
`detail.loaded`, `detail.failed`, `activation.started`, `activation.failed`,
and `activation.settled`. `opened` and `closed` must reset these fields. Existing
`form.*`, `history.*`, `confirm.*`, `busy.*`, and dirty-form behavior remains
byte-compatible.

- [ ] **Step 5: Run pure model tests and the existing model portions.**

Run: `node scripts/test-character-library-model.mjs`

Expected: PASS with filtering across name, summary, tags, category, and
capability terms; unknown category is visible under `uncategorized`; selected
state does not imply active state.

- [ ] **Step 6: Commit the isolated model change.**

```bash
git add src/renderer/modules/character-library-model.js scripts/test-character-library-model.mjs
git commit -m "feat: add character library presentation model"
```

## Task 2: Build the official productivity catalog contract

**Files:**
- Modify: `src/main/character-worlds/official-character-catalog.js`
- Modify: `scripts/test-official-character-catalog.mjs`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`

- [ ] **Step 1: Add a failing official-schema test.**

Replace the old fixed count assertion with invariants: exactly 18 unique IDs,
three complete locales, valid category IDs, and every professional role has
non-empty `summary`, `suitableFor`, `requiredInputs`, `workflow`,
`deliverables`, `qualityChecks`, and `boundaries`.

Assert the exact ID set:

```js
const expected = new Set([
  "lily-product-manager", "lily-project-manager", "lily-meeting-operator",
  "lily-contract-reviewer", "lily-spreadsheet-operator", "lily-cn-legal-counsel",
  "lily-researcher", "lily-data-analyst", "lily-market-analyst",
  "lily-content-editor", "lily-business-writer", "lily-presentation-strategist",
  "lily-architect", "lily-troubleshooter", "lily-automation-engineer",
  "lily-mentor", "lily-strategist", "lily-companion",
]);
assert.deepEqual(new Set(OFFICIAL_CHARACTERS.map((item) => item.id)), expected);
```

- [ ] **Step 2: Run the catalog test and verify it fails.**

Run: `node scripts/test-official-character-catalog.mjs`

Expected: FAIL on the existing four-role count and missing structured metadata.

- [ ] **Step 3: Implement structured localized metadata.**

Extend the catalog entry builder so the existing canonical character fields
remain unchanged while the official wrapper carries the new presentation and
professional-contract fields. Use stable category IDs:
`work-delivery`, `research-analysis`, `content-creation`, `technology-creation`,
`learning-life`.

Give the Chinese legal-counsel role this exact behavioral contract in its
canonical creator notes and structured metadata: confirm mainland-China
jurisdiction and cross-border elements, establish material date, verify current
primary authority where required, separate supplied facts/rules/analysis/open
questions, grade risk, and recommend human counsel for litigation, criminal
exposure, irreversible deadlines, major transactions, or incomplete facts.
The role must not claim to be licensed counsel or guarantee outcomes.

Use localized descriptions in the three supported locales. Do not place raw
instruction metadata in the public summary response; keep the detail metadata
behind the existing trusted official installation path or a bounded detail
response.

- [ ] **Step 4: Update locale strings and run contract tests.**

Run:

```bash
node scripts/test-official-character-catalog.mjs
node scripts/test-official-character-picker.mjs
```

Expected: PASS; English and Arabic summaries contain no accidental Chinese
fallback, and official markers remain present in installed canonical tags.

- [ ] **Step 5: Commit the catalog change.**

```bash
git add src/main/character-worlds/official-character-catalog.js scripts/test-official-character-catalog.mjs src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json
git commit -m "feat: add professional official character catalog"
```

## Task 3: Make official metadata safe and available to the library

**Files:**
- Modify: `src/main/official-character-ipc.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/modules/official-character-picker.js`
- Modify: `scripts/test-official-character-picker.mjs`

- [ ] **Step 1: Add failing summary/detail response tests.**

Assert the list response includes bounded `categoryId`, `summary`, tags,
`installedVersion`, `updateAvailable`, and a stable editorial order, but does
not include `canonical`, `workflow`, raw instruction text, or preserved user
payloads. Add a direct-detail path that returns only the safe localized official
metadata needed by the drawer.

- [ ] **Step 2: Implement the whitelisted response mapping.**

Update `publicOfficialCharacter` and the IPC mapping to copy only explicit
fields. Add `getOfficialCharacterDetail(officialId)` in the preload facade only
if the existing safe list cannot carry the drawer data; otherwise use the list
summary and a bounded detail map in the renderer. Keep installation main-side,
owner-scoped, and revision-pinned.

- [ ] **Step 3: Verify local-character fallback.**

When official list or detail loading returns `{ ok: false }`, the picker and
library retain local characters and the old popover selection path. Run:

```bash
node scripts/test-official-character-picker.mjs
```

Expected: PASS, including official-load failure and installed-row de-duplication.

- [ ] **Step 4: Commit the safe catalog bridge.**

```bash
git add src/main/official-character-ipc.js src/preload.js src/renderer/modules/official-character-picker.js scripts/test-official-character-picker.mjs
git commit -m "feat: expose safe official character metadata"
```

## Task 4: Add atomic explicit library activation

**Files:**
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/preload.js`
- Create or modify: `scripts/test-character-library-activation.mjs`
- Modify: `src/renderer/modules/character-library-actions.js`
- Modify: `src/renderer/modules/character-library.js`

- [ ] **Step 1: Write the main-process activation tests.**

Cover:

```js
await api.activateLibraryItem({
  sessionId: "session-a", kind: "character", revisionId: "rev-a",
  expectedBindingVersion: 2,
});
```

The test must prove owner scope is derived from the session, an unrelated
revision is rejected, stale binding versions return a conflict without a
partial write, policy denial leaves the current binding unchanged, and a valid
world-book activation appends/replaces only its permitted scope.

- [ ] **Step 2: Run the activation test and verify the channel is missing.**

Run: `node scripts/test-character-library-activation.mjs`

Expected: FAIL because the preload method and main handler do not exist.

- [ ] **Step 3: Add a guarded main handler with one commit boundary.**

Add `character:library-activate` with a whitelisted payload:

```text
sessionId, kind: character|persona|worldBook, revisionId,
expectedBindingVersion, scope, mergeStrategy
```

Resolve session authority main-side, validate the revision against the owner,
apply rollout policy to non-native selection, read current conversation config,
construct the normalized next config using existing `normalizeConversationConfig`,
and commit through the existing repository CAS transaction. For world books,
preserve existing books in other scopes and use the supplied safe default
`scope=chat`, `mergeStrategy=constant`. Return only binding/preview metadata,
never canonical content. Any error returns before commit or rolls back the full
transaction.

- [ ] **Step 4: Expose and consume the narrow preload method.**

Expose `activateLibraryItem(payload)` with field-by-field forwarding only.
In `character-library-actions.js`, obtain the active session ID from the
renderer session store, fetch the current binding version immediately before
activation, call the method, and dispatch `activation.settled` only on `{ ok: true }`.
On success dispatch `character-worlds:binding-changed` so the existing session
control refreshes its banner and mode. On failure keep the details drawer and
the current active selection unchanged.

- [ ] **Step 5: Run tests and commit.**

Run: `node scripts/test-character-library-activation.mjs`

Expected: PASS for owner isolation, CAS conflict, policy fallback, character,
persona, and world-book activation.

```bash
git add src/main/ipc-character-worlds.js src/preload.js scripts/test-character-library-activation.mjs src/renderer/modules/character-library-actions.js src/renderer/modules/character-library.js
git commit -m "feat: add atomic library activation"
```

## Task 5: Replace the list view with the three-pane library shell

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/character-library-view.js`
- Modify: `src/renderer/styles/character-library.css`

- [ ] **Step 1: Add DOM contract assertions to the Electron test.**

Assert the dialog contains `characterLibraryGroups`, `characterLibraryGrid`,
`characterLibraryDetail`, a search field, source/category filter controls, and
an explicit activation button. Preserve `characterLibraryList` as an alias or
compatibility host until existing tests and integrations migrate.

- [ ] **Step 2: Render groups and cards from pure state.**

Implement `renderGroupRail(state)` and `renderCatalogGrid(state)`. A card must
have `data-entity-id`, `data-library-select`, `aria-selected`, stable visual
marker, name, summary, tags, and source/status badges. Do not put edit/export/
archive buttons permanently on every card. A selected card opens the drawer;
it does not activate.

- [ ] **Step 3: Render domain-specific details.**

Implement `renderCharacterDetail`, `renderPersonaDetail`, and
`renderWorldBookDetail`. Character details show official workflow sections or
legacy canonical fields; persona details show completion and context fields;
world-book details show entries, scopes, health, conflict, and budget metadata.
All values use `textContent`; no catalog or imported text becomes HTML.

- [ ] **Step 4: Add compact action menus and preserve mutation controls.**

Place edit/history/duplicate/export/archive under a detail action menu. Keep
existing `data-library-action`, `data-library-restore`, confirm bars, and form
hosts so the current authoring tests continue to exercise the same operations.
The drawer close button must restore focus to the selected card or modal opener.

- [ ] **Step 5: Implement responsive and RTL styles.**

Use CSS grid with `repeat(3, minmax(0, 1fr))`, switch to two columns below the
existing medium modal width, and one column below the narrow breakpoint. Use
logical `margin-inline`, `padding-inline`, and `border-inline` properties for
Arabic. Keep radii within the existing design tokens, use no gradients or
decorative blobs, and add `prefers-reduced-motion` behavior.

- [ ] **Step 6: Run the Electron library test and fix only feature-owned failures.**

Run: `npx electron scripts/test-character-library.cjs`

Expected: PASS for opening, search, tabs, current mutation flows, dirty-form
guard, import/export/history, and the new grid/drawer selectors.

- [ ] **Step 7: Commit the shell.**

```bash
git add src/renderer/index.html src/renderer/modules/character-library-view.js src/renderer/styles/character-library.css scripts/test-character-library.cjs
git commit -m "feat: build grouped character library shell"
```

## Task 6: Complete persona and world-book details/templates

**Files:**
- Modify: `src/renderer/modules/character-library-actions.js`
- Modify: `src/renderer/modules/character-library-view.js`
- Modify: `src/renderer/modules/character-library-model.js`
- Modify: `src/renderer/modules/character-library.js`
- Modify: `src/main/character-worlds/world-book-inspection.js`
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/preload.js`
- Modify: `scripts/test-character-library.cjs`

- [ ] **Step 1: Add failing persona/world-book detail fixtures.**

Extend the Electron mock responses with persona context/completion metadata and
world-book scopes, health, conflict, and budget estimates. Assert that the
persona card never exposes authorization-shaped fields and that world-book
details never cross the bridge with raw entry content or activation keys.

- [ ] **Step 2: Map existing safe summaries into domain cards.**

Use `persona:list`, `world-book:list`, and the existing read-only detail calls.
For missing optional fields, render `Unknown`/localized unavailable state and
keep the card visible. Never infer a world-book entry count from raw content in
the renderer.

- [ ] **Step 3: Add completion and template states.**

Represent persona templates with explicit `completion: incomplete|ready`.
Disable activation for incomplete templates and focus the first missing field.
Represent world-book templates as authoring prompts handled by Lily, not as
runtime facts. Reuse `startAiAuthoring("personas"|"books")` for creation.

- [ ] **Step 4: Add multi-book activation presentation.**

Show active books, scope, merge strategy, conflicts, and estimated budget in
the details drawer. Call the atomic activation endpoint per selected book with
fresh binding version data; on a conflict reload the active config and show the
user what changed instead of silently retrying.

- [ ] **Step 5: Run the focused Electron test and commit.**

Run: `npx electron scripts/test-character-library.cjs`

Expected: PASS for persona completion, world-book safety, multi-book status,
and legacy tab mutation behavior.

```bash
git add src/renderer/modules/character-library-actions.js src/renderer/modules/character-library-view.js src/renderer/modules/character-library-model.js src/renderer/modules/character-library.js src/main/character-worlds/world-book-inspection.js src/main/ipc-character-worlds.js src/preload.js scripts/test-character-library.cjs
git commit -m "feat: add persona and world book library details"
```

## Task 7: Localization, accessibility, and scale verification

**Files:**
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `src/renderer/styles/character-library.css`
- Modify: `scripts/test-character-library.cjs`
- Create: `scripts/test-character-library-scale.mjs`

- [ ] **Step 1: Add locale-key completeness checks.**

Assert that every new `character.library.*` key exists in all three locale files,
including group labels, source/status labels, drawer sections, legal-role
boundary copy, empty/error/loading states, and ARIA labels.

- [ ] **Step 2: Add keyboard and focus assertions.**

In the Electron test, tab through group buttons and cards, select a card with
Enter/Space, verify `aria-selected` changes without activation, activate with
the primary button, close the drawer, and verify focus returns to the card.
Verify Arabic uses the document direction and no fixed left/right CSS offsets.

- [ ] **Step 3: Add deterministic scale fixtures.**

Create 30, 100, and 500 normalized summaries and assert filtering completes
without throwing, returns deterministic order, and does not mutate the source
array. Render a 100-item fixture under Electron and assert the grid has stable
card dimensions through computed styles.

- [ ] **Step 4: Run visual and full renderer verification.**

Run:

```bash
node scripts/test-character-library-model.mjs
node scripts/test-character-library-scale.mjs
npx electron scripts/test-character-library.cjs
npm run test:unit
```

Expected: all focused tests pass and the full suite remains green. Capture
wide, medium, narrow, and Arabic screenshots for manual overlap inspection.

- [ ] **Step 5: Commit verification and gate registration.**

Add a capability-gate row covering grouped-library errors, safe official role
metadata, explicit activation, persona placeholder exclusion, and world-book
fail-open behavior. Stage only the feature hunk in `CAPABILITY-GATE.md`.

```bash
git add src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json src/renderer/styles/character-library.css scripts/test-character-library.cjs scripts/test-character-library-scale.mjs CAPABILITY-GATE.md
git commit -m "test: verify production character library experience"
```

## Self-review

- Spec coverage: grouped grid and details are covered by Tasks 1 and 5; explicit
  activation and fail-open behavior by Task 4; official professional catalog
  and Chinese legal counsel by Task 2; personas/world books by Task 6;
  localization, accessibility, scale, and capability gate by Task 7.
- No unresolved placeholders remain in implementation decisions. The only
  runtime templates are explicitly incomplete and cannot enter context.
- Type/field consistency: `categoryId`, `source`, `summary`, `tags`,
  `revisionId`, `selectedItemId`, `activation`, `expectedBindingVersion`, and
  `worldBookRevisionId` are used consistently across the model, view, actions,
  preload, and main handler.
- Existing dirty-form, revision-CAS, owner-scope, and native-fallback contracts
  remain authoritative; the new library is an additional presentation and
  explicit activation path.
