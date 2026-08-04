# Persona and World Book Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Persona (我的设定) and World Book (世界书) understandable, discoverable, creatable, testable, and usable in real conversations without changing Lily's tools, permissions, safety, evidence, or native-turn behavior.

**Architecture:** Keep natural-language authoring as the primary creation and revision path. The library becomes the explanation, inspection, activation, and lifecycle surface. Persona content remains lower-authority narrative context; world-book content remains bounded inert data, with only whitelisted metadata and activation diagnostics crossing the renderer bridge. Existing immutable revisions, owner/session binding, CAS, admission snapshots, and fail-open runtime behavior remain the source of truth.

**Tech Stack:** Electron main process, CommonJS runtime modules, vanilla renderer modules, SQLite repositories and migrations, existing `lily_character_draft` authoring path, Node/MJS and Electron regression tests, three locale JSON files.

---

## Product contract

The user-facing names and meanings are fixed before implementation:

- **角色卡**: Lily is speaking as whom. It controls identity, voice, personality, opening behavior, and narrative boundaries.
- **我的设定**: who the user is in this conversation. Example: “我是创业公司的产品负责人，熟悉业务但不懂代码；回答先给结论，再给执行步骤。” It is narrative context only, never account identity, permissions, credentials, or authorization.
- **世界书**: reusable facts and rules for a conversation. Examples: a project glossary, brand language guide, customer-support SOP, or fictional world bible. Entries can be always-on or activated by matching conversation content.

Creation must be explainable in one sentence from the empty state:

```text
我的设定 = 让 Lily 更了解“我是谁、我偏好怎样沟通”。
世界书 = 让 Lily 在需要时记住“这个项目/故事里的事实、术语和规则”。
```

World books are not character personalities, executable scripts, tool permissions, or a replacement for uploaded source documents. A world book only supplies bounded lower-authority context.

## File map

- Modify `src/main/character-worlds/persona-model.js` and `src/main/character-worlds/world-envelope.js` — normalize and compile a useful structured persona while keeping old `{name, description}` revisions compatible.
- Modify `src/main/character-worlds/persona-inspection.js` — expose bounded persona completion metadata for the library without leaking authority-shaped fields.
- Modify `src/main/character-worlds/constants.js`, `src/main/store/persona-schema-migration.js`, and `src/main/character-worlds/persona-repository.js` only if the new persona fields require explicit limits or migration metadata.
- Modify `src/main/character-worlds/world-book-model.js` — add the bounded inert entry `title` field while keeping old entries compatible by falling back to their id.
- Create `src/main/character-worlds/official-context-catalog.js` — trusted persona and world-book starter templates; templates are incomplete and cannot be silently activated.
- Modify `src/main/ipc-character-worlds.js`, `src/main/ipc-character-authoring.js`, `src/main/official-character-ipc.js`, and `src/preload.js` — safe template/list/detail/preview/activation contracts. Do not expose raw world-book content through summary IPC.
- Modify `src/main/character-worlds/agent-draft-tools.js` and `src/main/character-worlds/authoring-intent.js` — explicit persona/world-book creation and revision prompts, with durable `ok: true` persistence receipts.
- Modify `src/renderer/index.html`, `src/renderer/modules/character-library.js`, `character-library-model.js`, `character-library-actions.js`, `character-library-view.js`, `character-library-detail-view.js`, and `character-binding-updates.js` — discoverable facet education, template cards, native-Lily composition, activation status, safe world-book inspection, and remove/test actions.
- Modify `src/renderer/i18n/locales/zh-CN.json`, `en.json`, and `ar.json` — names, explanations, empty states, examples, status/error text, and accessible labels.
- Modify focused tests under `scripts/` and update `CAPABILITY-GATE.md`, `docs/superpowers/specs/2026-08-02-character-worlds-unified-experience-design.md`, and `docs/character-worlds-gap-trace.md` after verification.

## Task 1: Lock the user journey and regression fixtures

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-character-worlds-unified-experience-design.md`
- Modify: `docs/character-worlds-gap-trace.md`
- Test: `scripts/test-character-authoring-intent.mjs`, `scripts/test-character-library-model.mjs`

- [ ] **Step 1: Add the three plain-language definitions and the end-to-end acceptance journeys.**

The acceptance journeys must cover:

1. Open the library, choose “我的设定”, understand the facet without reading external documentation, create a product-lead persona through Lily, inspect the saved revision, and use it with native Lily.
2. Open “世界书”, understand that it stores facts/rules rather than personality, ask Lily to create a project glossary with at least three entries, inspect safe entry summaries, test a matching message, add it to native Lily, and see the active book name below the composer.
3. Combine native Lily + persona + one world book, then remove the book while keeping the persona active.

- [ ] **Step 2: Add fixtures that distinguish creation from activation.**

Use these stable fixture values in tests:

```js
const personaRequest = "我是一个创业公司的产品负责人，熟悉业务但不懂代码。回答先给结论，再给执行步骤。";
const worldBookRequest = "为项目 Atlas 创建世界书：包含术语 Atlas、客户分级规则和发布审批规则；术语命中时才启用对应条目。";
```

Assert that a saved entity is required before activation and that an inactive draft cannot alter a turn.

- [ ] **Step 3: Run the focused baseline.**

Run: `node scripts/test-character-authoring-intent.mjs && node scripts/test-character-library-model.mjs`

Expected: PASS before implementation. Record the baseline output in the implementation commit message.

- [ ] **Step 4: Commit the product contract and fixtures.**

```bash
git add docs/superpowers/specs/2026-08-02-character-worlds-unified-experience-design.md docs/character-worlds-gap-trace.md scripts/test-character-authoring-intent.mjs scripts/test-character-library-model.mjs
git commit -m "docs: define persona and world book user journeys"
```

## Task 2: Make Persona a useful, compatible narrative profile

**Files:**
- Modify: `src/main/character-worlds/persona-model.js`
- Modify: `src/main/character-worlds/world-envelope.js`
- Modify: `src/main/character-worlds/constants.js`
- Test: `scripts/test-character-persona-store.mjs`, `scripts/test-character-persona-context.mjs`, `scripts/test-character-context-compiler.mjs`

- [ ] **Step 1: Write failing normalization and compatibility tests.**

Add tests for a structured persona containing `identity`, `background`, `expertise`, `communicationStyle`, `goals`, `preferences`, and `constraints`. Assert that old `{name, description}` revisions still normalize and compile, authorization-shaped fields still fail, arrays and strings remain bounded, and unknown fields remain inert.

- [ ] **Step 2: Run the tests and verify the new assertions fail.**

Run: `node scripts/test-character-persona-store.mjs && node scripts/test-character-persona-context.mjs`

Expected: FAIL because the current canonical normalizer and compiler only make `name` and `description` meaningful.

- [ ] **Step 3: Add bounded fields without changing authority.**

Normalize the following fields as narrative-only data:

```js
{
  name: string,
  identity: string,
  background: string,
  expertise: string[],
  communicationStyle: string,
  goals: string[],
  preferences: string[],
  constraints: string[],
  description: string
}
```

Keep the existing top-level authorization-key rejection. Add explicit per-field limits in `constants.js`; old revisions default missing fields to empty values.

- [ ] **Step 4: Compile a deterministic persona block.**

Build one bounded block in the existing persona slot. Emit only non-empty fields in a fixed order, keep the persona name attached to the block, and redact or omit content when the persona exceeds budget. Do not move persona data into user messages, visible history, tools, permissions, or evidence context.

- [ ] **Step 5: Run focused persona and capability tests.**

Run: `node scripts/test-character-persona-store.mjs && node scripts/test-character-persona-context.mjs && node scripts/test-character-context-compiler.mjs`

Expected: PASS, including native/no-persona byte parity and fail-open behavior.

- [ ] **Step 6: Commit the persona runtime.**

```bash
git add src/main/character-worlds/persona-model.js src/main/character-worlds/world-envelope.js src/main/character-worlds/constants.js scripts/test-character-persona-store.mjs scripts/test-character-persona-context.mjs scripts/test-character-context-compiler.mjs
git commit -m "feat: make personas useful narrative profiles"
```

## Task 3: Make Persona discoverable and usable in the library

**Files:**
- Create: `src/main/character-worlds/official-context-catalog.js` (Persona templates in this task; World Book templates in Task 4)
- Modify: `src/main/character-worlds/persona-inspection.js`
- Modify: `src/main/ipc-character-worlds.js`, `src/main/official-character-ipc.js`, `src/preload.js`
- Modify: `src/renderer/index.html`, `src/renderer/modules/character-library-model.js`, `character-library-actions.js`, `character-library-view.js`, `character-library-detail-view.js`, `character-library.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`, `en.json`, `ar.json`
- Test: `scripts/test-character-library.cjs`, `scripts/test-character-library-model.mjs`, `scripts/test-character-library-activation.mjs`, `scripts/test-character-library-locales.mjs`

- [ ] **Step 1: Add trusted starter templates.**

Add at least three incomplete persona templates: “产品负责人”, “研究者”, and “内容创作者”. Each template must include a localized explanation, intended use, fields still required from the user, and `officialTemplate: true`. Templates are never bound until the completion guard passes.

- [ ] **Step 2: Replace the ambiguous tab copy.**

Use “我的设定” as the primary Chinese label. Keep `persona` as the internal kind. The empty state must show the definition, one concrete example, and two actions: “让 Lily 根据我的话创建” and “从模板开始”.

- [ ] **Step 3: Add a completion-aware persona editor.**

Render fields for identity, background, expertise, communication style, goals, preferences, and constraints. Saving must create an immutable revision through the existing authoring service. The UI must show missing required fields and must disable activation only for incomplete personas.

- [ ] **Step 4: Fix independent activation visibility.**

Change the composer context calculation from “persona/world book only when a character is selected” to “each active facet is rendered independently”. Native Lily + persona and native Lily + world book must show their own names and statuses.

- [ ] **Step 5: Run renderer and activation tests.**

Run: `node scripts/test-character-library.cjs && node scripts/test-character-library-model.mjs && node scripts/test-character-library-activation.mjs && node scripts/test-character-library-locales.mjs`

Expected: PASS at desktop and narrow layout fixtures; native Lily plus persona renders an active persona indicator.

- [ ] **Step 6: Commit the Persona product surface.**

```bash
git add src/main/character-worlds/official-context-catalog.js src/main/character-worlds/persona-inspection.js src/main/ipc-character-worlds.js src/main/official-character-ipc.js src/preload.js src/renderer/index.html src/renderer/modules/character-library-model.js src/renderer/modules/character-library-actions.js src/renderer/modules/character-library-view.js src/renderer/modules/character-library-detail-view.js src/renderer/modules/character-library.js src/renderer/modules/character-binding-updates.js src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json scripts/test-character-library.cjs scripts/test-character-library-model.mjs scripts/test-character-library-activation.mjs scripts/test-character-library-locales.mjs
git commit -m "feat: ship discoverable persona setup"
```

## Task 4: Make World Book authoring understandable and durable

**Files:**
- Modify: `src/main/character-worlds/official-context-catalog.js` (add World Book templates)
- Modify: `src/main/character-worlds/authoring-intent.js`, `src/main/character-worlds/agent-draft-tools.js`
- Modify: `src/renderer/modules/character-library.js`, `character-library-actions.js`, `character-library-view.js`, `character-library-detail-view.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`, `en.json`, `ar.json`
- Test: `scripts/test-character-authoring-intent.mjs`, `scripts/test-character-agent-draft.mjs`, `scripts/test-character-authoring.mjs`, `scripts/test-character-authoring-ipc.mjs`

- [ ] **Step 1: Write failing authoring tests for the world-book journey.**

Assert that the library prompt identifies `worldBook`, that Lily must persist a canonical book with named entries, and that a Markdown/JSON file or a prose response alone does not count as a saved book. Add a revise test using an existing receipt and immutable base revision.

- [ ] **Step 2: Remove the empty-book trap.**

Production UI must not create a usable world book with only a name and `entries: []`. The “让 Lily 设计” action must insert the explicit world-book starter prompt and require a persisted `ok: true` draft. Keep test-only form helpers isolated from the user path.

- [ ] **Step 3: Add world-book starter templates.**

Add localized incomplete templates for “项目术语表”, “品牌语言指南”, “客户支持 SOP”, and “故事世界设定”. Each template must explain what an entry is and include example entry shapes without pretending the facts are already true.

- [ ] **Step 4: Add a durable natural-language revise flow.**

Support requests such as “把 Atlas 的发布审批规则改成两人复核” by routing them to `lily_character_draft` with `action: revise`, the entity kind `worldBook`, and the current immutable revision as the CAS base. Return an explicit result receipt with entry count, revision number, and whether the change was persisted.

- [ ] **Step 5: Run authoring tests.**

Run: `node scripts/test-character-authoring-intent.mjs && node scripts/test-character-agent-draft.mjs && node scripts/test-character-authoring.mjs && node scripts/test-character-authoring-ipc.mjs`

Expected: PASS with no durable write on disabled, malformed, ambiguous, over-budget, or failed-persistence paths.

- [ ] **Step 6: Commit the World Book authoring path.**

```bash
git add src/main/character-worlds/official-context-catalog.js src/main/character-worlds/authoring-intent.js src/main/character-worlds/agent-draft-tools.js src/renderer/modules/character-library.js src/renderer/modules/character-library-actions.js src/renderer/modules/character-library-view.js src/renderer/modules/character-library-detail-view.js src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json scripts/test-character-authoring-intent.mjs scripts/test-character-agent-draft.mjs scripts/test-character-authoring.mjs scripts/test-character-authoring-ipc.mjs
git commit -m "feat: make world book authoring durable"
```

## Task 5: Add safe World Book inspection, testing, and multi-book use

**Files:**
- Modify: `src/main/character-worlds/world-book-model.js`, `src/main/character-worlds/world-book-inspection.js`, `src/main/ipc-character-worlds.js`, `src/main/character-worlds/world-book-merge.js`
- Modify: `src/preload.js`, `src/renderer/modules/character-library-actions.js`, `character-library-detail-view.js`, `character-library-view.js`, `character-control-model.js`
- Test: `scripts/test-character-world-book-ipc.mjs`, `scripts/test-character-world-book-activation.mjs`, `scripts/test-character-world-book-merge.mjs`, `scripts/test-character-world-multi-book-wiring.mjs`, `scripts/test-character-library-activation.mjs`

- [ ] **Step 1: Define the safe inspection payload and entry title.**

Add an inert bounded `title` to each world-book entry. Existing entries without a title use their id for display. Expose only bounded metadata: entry id/title, enabled state, constant state, key counts, insertion position, applied/inert decorator counts, health, estimated token budget, and source revision. Never expose raw entry content, activation keys, preserved extensions, or decorator source lines through the summary bridge.

- [ ] **Step 2: Add read-only “测试这本世界书”.**

Add a main-side preview handler that accepts a bounded current-message sample and the pinned revision, runs the existing deterministic activation resolver, and returns only activated entry ids/labels, reasons, counts, and diagnostics. Preview must not mutate the binding or timed checkpoint.

- [ ] **Step 3: Add clear activation controls.**

World-book detail must show “添加到当前对话” when inactive and “从当前对话移除” when active. Activation must support native Lily with no character, preserve other active books, use the existing CAS binding version, and show merge strategy, conflicts, and budget before confirmation.

- [ ] **Step 4: Add multi-book tests.**

Cover constant entries, keyword-triggered entries, chat/persona/character/global precedence, duplicate prevention, remove-one-book behavior, budget overflow, corrupt revision fail-open, preview non-mutation, and same-session binding CAS conflicts.

- [ ] **Step 5: Run World Book tests.**

Run: `node scripts/test-character-world-book-ipc.mjs && node scripts/test-character-world-book-activation.mjs && node scripts/test-character-world-book-merge.mjs && node scripts/test-character-world-multi-book-wiring.mjs && node scripts/test-character-library-activation.mjs`

Expected: PASS; the renderer receives useful entry metadata but no raw world-book prose.

- [ ] **Step 6: Commit World Book inspection and activation.**

```bash
git add src/main/character-worlds/world-book-model.js src/main/character-worlds/world-book-inspection.js src/main/ipc-character-worlds.js src/main/character-worlds/world-book-merge.js src/preload.js src/renderer/modules/character-library-actions.js src/renderer/modules/character-library-detail-view.js src/renderer/modules/character-library-view.js src/renderer/modules/character-control-model.js scripts/test-character-world-book-ipc.mjs scripts/test-character-world-book-activation.mjs scripts/test-character-world-book-merge.mjs scripts/test-character-world-multi-book-wiring.mjs scripts/test-character-library-activation.mjs
git commit -m "feat: make world books testable and composable"
```

## Task 6: Finish shared UX, capability gates, and release verification

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/styles/character-library.css`
- Modify: `src/renderer/i18n/locales/zh-CN.json`, `en.json`, `ar.json`
- Modify: `CAPABILITY-GATE.md`
- Modify: `docs/superpowers/specs/2026-08-02-character-worlds-unified-experience-design.md`
- Modify: `docs/character-worlds-gap-trace.md`
- Test: `scripts/test-character-worlds-capability-gate.mjs`, `scripts/test-character-context-injection.mjs`, `scripts/test-character-binding-isolation.mjs`, `scripts/test-character-compaction-isolation.mjs`, `scripts/test-character-library.cjs`

- [ ] **Step 1: Add empty, loading, unavailable, incomplete, active, and bypassed states.**

Every state must explain what the facet does and give one next action. Long names and Chinese/English/Arabic copy must not overlap the grid, drawer, composer strip, or buttons.

- [ ] **Step 2: Register the new guards.**

Add tests that fail if native Lily + persona/world book changes the native kernel prompt, if persona fields become authority, if raw world-book content crosses summary IPC, if a preview mutates durable state, or if a selected-but-bypassed facet renders active.

- [ ] **Step 3: Run the complete focused suite.**

Run:

```bash
node scripts/test-character-worlds-capability-gate.mjs
node scripts/test-character-context-injection.mjs
node scripts/test-character-binding-isolation.mjs
node scripts/test-character-compaction-isolation.mjs
node scripts/test-character-library.cjs
node scripts/test-character-persona-context.mjs
node scripts/test-character-world-book-compile.mjs
node scripts/test-character-world-book-state-machine.mjs
```

Expected: PASS. Any failure that changes native bytes, tools, permissions, evidence, files, or model routing blocks release.

- [ ] **Step 4: Run the repository unit suite and record environmental skips.**

Run: `npm run test:unit`

Expected: all feature tests pass; unrelated sandboxed loopback, LibreOffice, or Electron-startup failures must be recorded with exact command and environment rather than called passing.

- [ ] **Step 5: Perform manual acceptance in the packaged app.**

Verify these exact paths on macOS and Windows:

1. Empty library explains both facets.
2. Persona template can be completed, saved, used with native Lily, and removed without deleting the revision.
3. World-book request creates at least three entries, preview identifies the correct entry, add/remove works, and the composer shows the book name without a character card.
4. Two world books compose deterministically; duplicate add is idempotent; budget/conflict warnings are visible.
5. Restart preserves the selected immutable revisions and active facet names.
6. Disable Character Worlds and confirm native Lily is byte-equivalent and retains all existing capabilities.

- [ ] **Step 6: Update status and commit the release verification.**

```bash
git add src/renderer/index.html src/renderer/styles/character-library.css src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json CAPABILITY-GATE.md docs/superpowers/specs/2026-08-02-character-worlds-unified-experience-design.md docs/character-worlds-gap-trace.md scripts/test-character-worlds-capability-gate.mjs scripts/test-character-context-injection.mjs scripts/test-character-binding-isolation.mjs scripts/test-character-compaction-isolation.mjs scripts/test-character-library.cjs scripts/test-character-persona-context.mjs scripts/test-character-world-book-compile.mjs scripts/test-character-world-book-state-machine.mjs
git commit -m "feat: complete persona and world book release gates"
```

## Definition of done

- A new user can explain Persona and World Book after reading only the in-app empty state.
- Persona can be created, inspected, edited through immutable revisions, activated independently with native Lily, and visibly removed.
- World Book can be created and revised through natural language, contains inspectable safe entry metadata, supports deterministic preview, supports add/remove and multiple active books, and reports budget/conflict health.
- The active names and statuses are visible below the composer even when no character card is selected.
- No raw world-book content or executable imported behavior crosses the renderer safety boundary.
- Native Lily behavior, tools, permissions, evidence, files, model selection, and exact task-output protections remain unchanged when the facets are absent, disabled, invalid, over budget, or bypassed.
- Focused tests, full unit tests, and macOS/Windows manual acceptance are recorded. Until the last two are complete, the feature status remains “release verification pending”.
