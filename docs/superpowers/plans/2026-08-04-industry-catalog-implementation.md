# Industry Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Lily Workbench's official library to approximately 60 industry-aware roles and 20 practical world books while preserving the existing install, edit, activation, and provenance contracts.

**Architecture:** Keep the current public catalog APIs and IPC unchanged. Add a focused industry role module and extend the official context catalog with a second, clearly bounded set of industry world books; merge both into the existing read APIs. Add category ordering/translations and data-driven tests that reject incomplete or duplicate official content.

**Tech Stack:** Node.js CommonJS catalog modules, Electron IPC/preload already in place, renderer ES modules, JSON locale files, Node assertion tests.

---

### Task 1: Add the industry role catalog module

**Files:**
- Create: `src/main/character-worlds/official-industry-character-catalog.js`
- Modify: `src/main/character-worlds/official-character-catalog.js`
- Test: `scripts/test-official-character-catalog.mjs`

- [x] Define one reusable role factory in the new module with localized category labels, explicit workflow, deliverables, quality checks, and high-risk boundaries.
- [x] Add 45 distinct roles covering business operations, technology, data/AI, design/engineering, education, healthcare, legal/finance, real estate/manufacturing/supply chain, commerce/customer work, media/localization, hospitality/events, nonprofit, agriculture, public administration, retail, restaurant operations, insurance claims, and mental-health navigation.
- [x] Merge the module into `ALL_OFFICIAL_CHARACTERS` and export the industry list for deterministic tests.
- [x] Extend the catalog test to assert 67 total roles, unique IDs, supported categories, complete localized canonical fields, English canonical localization, Arabic fallback honesty, and boundary text for regulated roles.
- [x] Run `node scripts/test-official-character-catalog.mjs` and expect PASS.

### Task 2: Add industry world books

**Files:**
- Modify: `src/main/character-worlds/official-context-catalog.js`
- Test: `scripts/test-official-context-catalog.mjs`

- [x] Add 14 world books so the total reaches 21, covering HR/recruiting, software engineering, cybersecurity, data/AI, design/engineering, education, healthcare, legal/compliance, finance/accounting, real estate/construction, manufacturing/supply chain, commerce/sales/customer work, hospitality/events, and public/nonprofit/agriculture workflows.
- [x] Give every pack 3 to 5 entries, at least one constant boundary/rule, primary and secondary keys, insertion position, scan policy, and Chinese/English canonical content.
- [x] Merge the additions through the existing official list/get functions without changing IPC payloads or install semantics.
- [x] Extend the context catalog test to assert 21 books, unique IDs, entry structure, nonzero token budgets, constant rules, regulated-domain boundary language, non-recursive activation, positive trigger coverage, and unrelated-text isolation.
- [x] Run `node scripts/test-official-context-catalog.mjs` and expect PASS.

### Task 3: Make industry categories first-class in the library

**Files:**
- Modify: `src/renderer/modules/character-library-model.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Test: `scripts/test-character-library-model.mjs`
- Test: `scripts/test-character-library-locales.mjs`

- [x] Add category ordering for the new role and world-book category IDs so industry groups appear in deliberate order.
- [x] Add translated labels for every new category in all three locale files.
- [x] Verify category derivation, filtering, and locale parity with the existing model/locale tests.

### Task 4: Verify install and regression contracts

**Files:**
- Test: `scripts/test-character-worlds-ipc.mjs`
- Test: `scripts/test-character-authoring-ipc.mjs`

- [x] Run the official install/provenance/idempotency IPC test against the expanded catalog.
- [x] Run the authoring IPC test to ensure installed industry roles and world books remain editable revisions.
- [x] Run Node syntax checks for all changed modules and `git diff --check`.
- [x] Run the focused catalog, model, locale, IPC, authoring, and library tests together and report any Electron smoke-test limitation separately.
