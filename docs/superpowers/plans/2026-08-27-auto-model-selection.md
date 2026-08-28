# Auto Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamic model selector to the Lily composer with `自动` as the default, a user-configurable Auto candidate pool, and manual selection of models actually published to the current user.

**Architecture:** The server-managed model catalog remains the source of truth. Main-process model selection owns the session preference and validates every model ID; the renderer owns only presentation and sends a selection snapshot with each turn. Auto resolves a private execution environment and public model profile together before dispatch. Engines share only compatible execution configurations; the selected profile drives both the request override and OpenCode helper defaults without restarting other busy sessions.

**Tech Stack:** Electron IPC, vanilla renderer modules, JSON i18n, Node.js unit/integration tests, existing OpenCode runtime adapter.

---

## Implementation checkpoint (2026-08-29)

The original task checklist below is the full design backlog, not a declaration
that every proposed field or advanced router is shipped. The following is the
current executable contract and takes precedence over illustrative shapes below.

- [x] Dynamic published models, explicit Auto/manual modes and custom pools.
- [x] Atomic conversation preferences in `model-selection.json`, with migration
  from the earlier unscoped selection object.
- [x] Main-process session/model validation; the picker never restarts a runner.
- [x] Separate runtime provider connections, including custom Anthropic mapping.
- [x] Main-turn request override, steer/TODO continuation inheritance, source-turn
  receipt recovery and queue selection persistence.
- [x] Save rollback, await-before-send, refresh retry, child-target clicks,
  exclusive lists, Escape/focus restoration and bounded scrolling.
- [x] Provider-aware archive token estimates and stable companion role control.
- [x] Selected-model execution environment, helper pins, context limits and
  compaction budget; concurrent execution profiles with A/B/A engine reuse.
- [x] Tool/history requirements at admission, quality floor before vision,
  per-model capabilities and model-attributed usage with serialized report retries.
- [x] Latest full-suite rerun: 650/650 scripts passed in 308 seconds. Additional
  bulk-input staging coverage passed separately after its test was extended.
  Actual upstream OpenCode provider Schema validation also passed locally.
- [ ] Production catalog rating publication, real multi-provider requests and
  packaged desktop acceptance. No deployment or paid-model calls in this audit.

Actual APIs:

```js
listModelSelection(sessionId)
setModelSelection(selection, sessionId)
// IPC: models:selection-list { sessionId }
// IPC: models:set-selection { selection, sessionId }
selection = {
  mode: "auto", // or "manual"
  autoPoolMode: "recommended", // or "custom"
  autoModelIds: ["published-id"],
  manualModelId: "published-id"
}
```

Main-process `model-selection-catalog.js` owns persistence and connection
resolution, keeping `model-presets.js` unchanged. `model-selection.js` is pure.
Runtime-only connection env never crosses IPC. The service emits optional
`routing: { quality, cost }` from each provider's model metadata; absence stays
unknown, not zero. Quality ranks higher, cost ranks lower. Ratings must share a
calibrated scale; they are not inferred from names, roles or model list order.

Recommended Auto uses the active candidate as its quality floor. When every
eligible candidate has ratings, long input (>6000 characters) or >=4 attachments
prioritizes quality; otherwise it may minimize cost without going below that
floor. Missing ratings keep the baseline. Image input prefers native vision only
inside that quality floor; otherwise the existing vision bridge remains available.
Admission requires tools and estimates context from retained engine usage plus
the new message and a reserve. Auto prefers a fitting window but preserves bulk
input staging/history compaction when none fits. Pre-turn and background
compaction use the selected model's budget. This is an estimate, not a second
copy of the full engine transcript; structured per-skill requirements remain future work.

Each main turn records `{mode, reason, modelId, providerId, selectionId, selection, label}`
in `metadata.modelRoute` and `engine.trace.modelRoute`. Source-turn retry uses
the receipt, not the latest preference. Steer and internal main-task continuations
reuse the same OpenCode session and request override. General/explore subagents,
compaction and title defaults follow the same selected execution configuration.
Private connection env never enters receipts or IPC. A failed configuration
refresh cannot reuse an engine for a different model. Usage is separated by
actual model within a session, and failed uploads do not re-add local totals;
price calibration and production billing acceptance are not included.

Verification executed: 14 behavioral cases in `test-model-selection.mjs`, seven
execution-consistency cases, real runner config tests, four usage-report cases, IPC,
queue recovery, terminal CAS, archive, service catalog, image/document flow,
renderer interaction and character toolbar tests. Chrome component QA passed
at 1440x900, 390x844 and 800x400: real pointer clicks, 20-model scrolling, pending
save, failed-save rollback, session switching during an awaited load, catalog
retry and no page errors.
The browser fixture uses real DOM/CSS/controller with mocked service responses;
it is not production model-service integration evidence.

Remaining advanced design: semantic complexity evaluation, observed provider
health/latency, precise pre-routing transcript accounting, structured skill
requirements, independent internal-agent routing, per-turn user-visible model
receipts and calibrated cross-model monetary cost reporting.

## Scope and boundaries

- Do not hardcode `fdeepseek1~7` or any future model list.
- Do not add business-domain model labels such as legal or finance models.
- Do not redesign character, skill, or knowledge-base storage.
- Preserve the existing single-model path when the catalog or Auto data is unavailable.
- Do not change the current runner while a turn is active.

## Files to create or modify

- Create: `src/main/model-selection.js` — validated Auto/manual preference state, catalog projection, and deterministic route selection.
- Create: `scripts/test-model-selection.mjs` — unit tests for catalog filtering, preferences, and routing.
- Modify: `src/main/model-presets.js` — expose normalized published model entries and persist selection preferences without breaking existing presets.
- Modify: `src/main/ipc-models.js` — add list/set-model-selection IPC handlers.
- Modify: `src/preload.js` — expose model selection methods to the renderer.
- Modify: `src/main/turn-orchestrator.js` or its existing turn admission boundary — capture the selection snapshot before dispatch and pass it to the assistant input path.
- Modify: `src/main/opencode-agent-session.js` and/or the existing input contract only if the current turn boundary does not carry the snapshot to OpenCode.
- Modify: `src/main/runtime/opencode-message-parts.js` only if the existing per-prompt model override cannot consume the selected model shape.
- Modify: `src/renderer/index.html` — add the composer model button and popover.
- Create: `src/renderer/modules/model-picker.js` — renderer-only popover state and DOM rendering.
- Modify: `src/renderer/modules/composer.js` — initialize picker and include the selection snapshot in sends.
- Modify: `src/renderer/i18n/locales/zh-CN.json` and `src/renderer/i18n/locales/en.json` — all user-facing picker labels and errors.
- Modify: `src/renderer/styles/composer.css` — responsive picker styling.
- Modify: `scripts/test-renderer-import.cjs` or add a focused renderer test — ensure the picker imports without browser globals leaking into main code.

## Task 1: Define the model-selection contract

- [ ] Add a normalized public model shape:

```js
{
  id: "service-model-id",
  label: "Model display name",
  providerID: "provider-id",
  modelID: "backend-model-id",
  status: "available",
  capabilities: {
    reasoning: true,
    vision: false,
    toolCall: true,
    structuredOutput: true,
    longContext: true
  },
  limits: { contextTokens: 1000000, outputTokens: 384000 },
  source: "managed"
}
```

- [ ] Add a selection shape:

```js
{
  mode: "auto",
  auto: {
    source: "recommended",
    allowedModelIds: []
  },
  manualModelId: null
}
```

- [ ] Add a turn snapshot shape:

```js
{
  mode: "auto",
  candidateModelIds: ["service-model-id"],
  selectedModelId: "service-model-id",
  catalogVersion: "catalog-version",
  reasonCodes: ["default_recommended"],
  fallback: null
}
```

- [ ] Preserve the existing `activePresetId` and custom model compatibility fields. New fields must be optional and default to Auto using the current active model when no multi-model catalog exists.

## Task 2: Implement main-process model selection

- [ ] Create pure functions in `src/main/model-selection.js`:
  - `normalizeCatalog(catalog)` removes malformed, disabled, duplicate, and unauthorized entries.
  - `normalizeSelection(selection, catalog, fallbackModelId)` validates mode and intersects custom IDs with the catalog.
  - `listSelectionPublic()` returns only non-secret public data.
  - `setSelection(selection)` persists normalized data.
  - `routeTurn(input)` filters by hard capabilities and selects one model deterministically.

- [ ] Use this route order:
  1. manual mode validates the selected model;
  2. Auto resolves recommended or custom candidates;
  3. image/file/tool/context requirements remove incompatible models;
  4. quality and stability rank ahead of cost and latency;
  5. stable ID ordering breaks ties;
  6. no eligible model returns a typed `NO_ELIGIBLE_MODEL` result instead of silently choosing an incompatible model.

- [ ] Use only metadata for the first implementation. Do not invoke another LLM to route a turn.

- [ ] Add explicit capability inputs for attachments, tools, structured output, and estimated context. Legal or other character domains may contribute minimum requirements, but no domain field is added to model entries.

## Task 3: Add model-selection IPC

- [ ] Add `models:selection-list` returning:

```js
{
  ok: true,
  selection,
  models,
  catalogVersion,
  recommendedModelIds,
  fallbackModelId
}
```

- [ ] Add `models:selection-set` accepting `{ mode, auto, manualModelId }`.
- [ ] Reject invalid or unauthorized model IDs in the main process.
- [ ] Do not run `withRunnerChange` for a per-turn selection change; changing a picker value must not restart or interrupt a runner. Existing global model settings continue to use their current lifecycle.
- [ ] Add preload methods `listModelSelection()` and `setModelSelection(payload)`.

## Task 4: Add the composer picker

- [ ] Add a single compact composer control labeled `自动` on first load.
- [ ] Add a popover with:
  - `自动` / `手动` mode control;
  - system recommended vs custom Auto pool;
  - actual models returned from IPC;
  - manual single-model selection;
  - restore recommended action;
  - unavailable/permission states;
  - save and cancel behavior.
- [ ] Use the server-provided display label, never derive a business label from the model ID.
- [ ] Keep role, skill, schedule, and attachment controls as separate composer controls.
- [ ] Close on Escape and outside click; preserve keyboard focus; set `aria-expanded`, `aria-controls`, and selected states.
- [ ] While a turn is running, allow editing the next-turn preference only if the current code can guarantee the snapshot is captured at send time; never mutate the in-flight turn.
- [ ] On small windows, constrain the popover to the viewport and make the model list scroll internally.

## Task 5: Carry the selection into a turn

- [ ] At send time, read the picker state once and pass it as an immutable selection snapshot through the existing assistant input payload.
- [ ] At the main-process turn admission boundary, revalidate the snapshot against the latest catalog and user entitlement.
- [ ] Call `routeTurn()` before OpenCode dispatch.
- [ ] Attach the resulting route receipt to the turn metadata.
- [ ] Pass the selected provider/model to the existing OpenCode prompt body as `{ providerID, modelID }`.
- [ ] Do not rebuild or restart a busy OpenCode session because the selected model changed for one turn.
- [ ] If Auto has no eligible model, return a recoverable user-facing error with actions to restore recommendations, edit the pool, or choose manually.

## Task 6: Add user-facing copy and styling

- [ ] Add Chinese and English keys for mode names, pool settings, model status, empty pool, no eligible model, restore recommendation, and actual route details.
- [ ] Keep the primary label short: `自动`, `自动 · N 个模型`, or the selected model display label.
- [ ] Do not expose provider secrets, backend URLs, internal route scores, or domain classifications.
- [ ] Render only objective badges such as reasoning, vision, tools, context, speed, and availability when present in the catalog.

## Task 7: Tests first and regression coverage

- [ ] Add failing tests in `scripts/test-model-selection.mjs` for:
  - default Auto with a single fallback model;
  - dynamic catalog entries with arbitrary IDs;
  - custom pool intersection with published models;
  - manual selection validation;
  - image capability filtering;
  - context-limit filtering;
  - tool-call filtering;
  - deterministic tie-breaking;
  - no eligible model error;
  - catalog unavailable fallback;
  - no legal/finance/domain model field required.

- [ ] Add or extend an IPC test for list/set selection and unauthorized IDs.
- [ ] Add an OpenCode request assertion that the selected provider/model is sent per turn.
- [ ] Add a session test proving two turns in one session can select different models without resetting the conversation ID.
- [ ] Add a failure test proving a post-side-effect turn is not automatically replayed with another model.
- [ ] Add renderer import and DOM-state tests for default Auto, manual selection, custom pool persistence, Escape close, and responsive list behavior.

## Task 8: Verification and delivery

- [ ] Run `node scripts/test-model-selection.mjs`.
- [ ] Run the focused model, turn, and OpenCode tests.
- [ ] Run `npm run test:unit`.
- [ ] Run `npm run test:renderer`.
- [ ] Run `git diff --check`.
- [ ] Review the diff for accidental hardcoded model names, business-domain model labels, secret exposure, and runner restarts.
- [ ] Update the design document status from design confirmation to implementation status only after the tests pass.

## Definition of done

- Composer defaults to Auto.
- Auto candidates and manual choices come from the server-managed model catalog.
- No fixed model list or business-domain model category exists in the UI or routing contract.
- Auto selects one eligible model before each turn.
- Manual mode selects one user-authorized model.
- Per-turn model selection works in one durable OpenCode conversation.
- The actual selected model and fallback reason are observable.
- Existing single-model deployments continue to work when the new catalog is unavailable.
- Focused and regression tests pass.
