# 角色卡唯一模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable standalone personas, task settings, and world books at every user-visible and runtime boundary while preserving character-card conversations and old database compatibility.

**Architecture:** Add one main-process normalization boundary that projects every conversation binding/snapshot to character-card-only data. Reject new facet mutations with `FEATURE_DISABLED`, and keep old records inert. Reduce the renderer library to the character tab and remove facet state/badges while preserving character revision pinning.

**Tech Stack:** Electron main process, SQLite repository, preload IPC facade, ES modules in renderer, Node test scripts.

---

### Task 1: Define and test the character-card-only projection

**Files:**
- Create: `src/main/character-worlds/character-card-only.js`
- Modify: `scripts/test-character-conversation-config.mjs`
- Modify: `scripts/test-character-worlds-store.mjs`

- [x] Add pure helpers that keep only `characterRevisionId`, `greetingIndex`, `sceneId`, `groupId`, and character mode metadata; force `personaRevisionId` to `null` and `books` to `[]`.
- [x] Add failing tests proving an old config containing a persona pin and multiple book bindings projects to character-only data, while native mode remains native.
- [x] Run the focused tests and confirm the new assertions fail before production wiring.

### Task 2: Enforce the projection in admission, persistence, and IPC

**Files:**
- Modify: `src/main/character-worlds/conversation-config-repository.js`
- Modify: `src/main/character-worlds/repository.js`
- Modify: `src/main/store/character-worlds-admission-snapshot.js`
- Modify: `src/main/character-worlds/preview-store.js`
- Modify: `src/main/character-worlds/experience-ipc.js`
- Modify: `src/main/ipc-character-worlds.js`
- Modify: `src/main/ipc-character-authoring.js`
- Modify: `scripts/test-character-worlds-ipc.mjs`
- Modify: `scripts/test-character-worlds-experience-ipc.mjs`
- Create: `scripts/test-character-card-only-runtime.mjs`

- [x] Wire the projection into reads, writes, and admission so stale persona/world-book fields never reach a turn snapshot; any binding write clears the effective facet rows without deleting historical data.
- [x] Make library activation, preview activation, persona mutations, world-book mutations, and official facet installation return `FEATURE_DISABLED`; native deselection and character-card activation remain available.
- [x] Add a runtime regression test that seeds an old binding and embedded character book, admits a turn, builds the OpenCode body, and asserts no persona/world-book content or world-book checkpoint is produced.
- [x] Run the focused IPC and runtime tests and confirm character-card paths remain green.

### Task 3: Reduce the renderer to character cards

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/character-library-model.js`
- Modify: `src/renderer/modules/character-library-view.js`
- Modify: `src/renderer/modules/character-library-actions.js`
- Modify: `src/renderer/modules/character-library-detail-view.js`
- Modify: `src/renderer/modules/character-library.js`
- Modify: `src/renderer/modules/character-session-control.js`
- Modify: `src/renderer/modules/character-binding-updates.js`
- Modify: `src/renderer/modules/character-library-receipt-view.js`
- Modify: `scripts/test-character-library-model.mjs`
- Modify: `scripts/test-character-library.cjs`
- Modify: `scripts/test-character-session-control.mjs`

- [x] Restrict library tabs, requested tabs, item loading, authoring, detail actions, receipt routing, and form rendering to `characters`.
- [x] Remove persona/world-book badges and preview controls from the session role projection; preserve character application status and native Lily behavior.
- [x] Add failing renderer tests for one-tab state, rejected facet tab input, and absence of facet badges, then implement the minimal model/view changes.
- [x] Run the renderer model/session tests and the static CSS/i18n checks.

### Task 4: Full verification and documentation consistency

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-character-card-only-design.md` only if verification exposes a contract mismatch.

- [ ] Run all character-card, admission, prompt-injection, IPC, and library tests affected by the change.
- [x] Run `git diff --check` and inspect the final diff for unrelated modifications.
- [x] Confirm the capability gate: failure or stale data falls back to native Lily or the character-card baseline, never to facet injection.
- [x] Update the implementation plan checkboxes as each task completes.
