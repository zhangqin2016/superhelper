# Usage Model Details Implementation Plan

**Goal:** Show this device's actual provider/model usage by date and by model without changing execution or billing.

**Architecture:** Keep the existing usage IPC and server endpoint. Normalize persisted and pending counters through one summary builder. Server daily totals remain authoritative; missing attribution is explicit. If reporting changes during a server read, use a fresh local snapshot instead of adding overlapping counters.

**Tech Stack:** Electron main-process CommonJS, renderer ES modules, native disclosure/table controls, existing i18n and Node/Electron tests.

## Scope And Invariants

- Daily disclosure and an aggregated model view, defaulting to daily view.
- Identity is the exact provider/model pair from runtime usage, never today's selected model, role, or Auto mode.
- Current catalog names may decorate an exact pair only; unknown identities stay visible.
- Preserve legacy totals, expose unallocated residuals, and reject inconsistent detail rather than invent attribution.
- Use a local-calendar 30-day inclusive range. Pending usage preserves its recorded date, including midnight crossings.
- Fees remain the existing uniform reference estimate, explicitly not actual model pricing or billing. Preserve sub-cent values for display.
- Loading, refresh, empty, offline, and unavailable states; locale changes and keyboard access must work.
- No per-request ledger, account-wide reporting, task attribution, server schema changes, release, or automatic commits.

## Implementation

### 1. Regression Tests

- Add `scripts/test-usage-model-details.mjs`: same-name/different-provider separation, legacy residual, invalid detail, current pending models, calendar boundaries, and sub-cent estimates.
- Extend `scripts/test-usage-reporter-models.mjs`: immutable pending snapshots, revision changes, unconfirmed uploads, and retry stability.
- Add `scripts/test-usage-settings.mjs`: preserve remote detail, local fallback, in-flight upload/read overlap, unavailable catalog, and exact-pair decoration.
- Make existing summary/store test dates relative to their execution day.
- Run each new test before implementing and confirm an assertion failure for the missing behavior.

### 2. Data Path

- `src/main/usage-summary.js`: reconcile daily counters and provider/model detail, add pending records once, calculate model totals and reference estimates in the same natural-day window.
- `src/main/usage-local-store.js`: pass stored model detail through the shared builder instead of attaching a separate unmerged array.
- `src/main/usage-reporter.js`: read-only snapshots of all pending records, revision counter and unconfirmed-upload state; no new timer or reporting work.
- `src/main/usage-settings.js`: use server detail only with a stable reporting snapshot, otherwise read local immediately; optional exact-pair public catalog decoration must fail open.

### 3. Renderer

- `src/renderer/index.html`: usage scope, view controls, refresh/status, date/model surfaces and reference-price disclosure.
- `src/renderer/modules/usage-settings.js`: safe DOM/text rendering, disclosure state, view switching, loading/error states, and locale refresh.
- `src/renderer/styles/settings.css`: compact restrained styling, fixed table tracks, long identities wrapping and narrow-container layout.
- `src/renderer/i18n/locales/{zh-CN,en,ar}.json`: labels and honest estimate/source/unknown copy.
- Add renderer regression coverage using the actual module and HTML with mocked IPC only.

### 4. Verification

- Run usage summary/store/reporter/settings/provider-persistence and runtime accounting tests.
- Verify date expansion, model switching, refresh racing, errors, unknown models, locale switching and XSS text handling.
- Inspect desktop and narrow-screen screenshots in light/dark themes; assert no document overflow or clipped identities.
- Run the repository unit suite and `git diff --check`; report any skip or unrelated failure without reverting other work.

## Progress

- [x] Approved scope and existing data path inspected.
- [x] Failing data-path regression tests recorded.
- [x] Summary and snapshot wiring complete.
- [x] Renderer and translations complete.
- [x] Automated and visual verification complete.

## Verification Results

- `node scripts/run-all-tests.mjs`: 662/662 scripts passed in 360 seconds.
- Focused usage, locale, renderer-primitive and telemetry-date regressions: 23 passed, 1 optional PostgreSQL integration skipped (`USAGE_TEST_DATABASE_URL` was not configured). No server schema or route was changed.
- `node scripts/test-opencode-bundled-usage.mjs`: real bundled OpenCode 1.18.21 accounting passed for main, child and compaction work with replay deduplication. The existing title-call usage-event limitation is unchanged.
- `test-usage-model-details.mjs` passed under the host timezone, Pacific/Honolulu (UTC-10) and Pacific/Kiritimati (UTC+14).
- `electron scripts/test-usage-settings-ui.cjs`: actual renderer HTML/module, native keyboard disclosure, date/model views, preserved disclosure/view state, loading/error/empty states, stale response exclusion, XSS text handling and zero-token selection exclusion passed.
- Ten screenshots cover both views at desktop/narrow widths, Chinese/English/Arabic and light/dark themes. Screenshots are test fixtures in `/tmp/lily-usage-ui-20260831`, not user data or release assets. Long identities and page overflow assertions passed; renderer console errors were empty.
- No polling timer, scheduler, external reporting trigger, model-routing change, commit, package build or deployment was added.
