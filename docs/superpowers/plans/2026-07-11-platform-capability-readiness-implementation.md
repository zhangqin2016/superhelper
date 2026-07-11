# Platform Capability Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-use dependencies install automatically and visibly for the minimum current-task capability, refresh the runner/MCP before a single dispatch, and preserve the complete strong-default execution surface for every model grade.

**Architecture:** Add a pure capability-readiness planner above the existing runtime-pack catalog, then a main-process preparation coordinator that installs required packs before engine dispatch and treats enhancements as non-blocking. Keep the existing installer as the artifact authority, harden it for resumable downloads and health-checked activation, and make runner/MCP refresh part of readiness rather than an afterthought. Every new path is fail-open: planner, artifact, install, refresh, or UI failure dispatches the original turn once through today's baseline.

**Tech Stack:** Electron main/renderer, Node.js CommonJS/ESM, OpenCode session runners, MCP, existing runtime-pack CDN/API, filesystem staging, Node test scripts under `scripts/test-*.mjs`.

---

## File and responsibility map

**Create**

- `src/main/capability-readiness.js` — pure task-to-capability/required/enhancement/fallback plan and readiness result types.
- `src/main/runtime-pack-coordinator.js` — bounded, deduplicated main-process preparation jobs and outcome aggregation.
- `src/main/runtime-pack-download.js` — resumable artifact download, retry, metadata, and disk-space preflight; no Electron dependency.
- `resources/runtime/runtime-pack-lock.json` — generated exact component/version/hash matrix for published artifacts.
- `scripts/test-capability-readiness.mjs` — pure planning and strong-default fallback guards.
- `scripts/test-runtime-pack-coordinator.mjs` — concurrency, dedupe, failure, and refresh contracts.
- `scripts/test-runtime-pack-download.mjs` — Range resume, retry, checksum handoff, and disk-space tests with a local HTTP server.
- `scripts/test-turn-dependency-readiness.mjs` — admitted-before-prepare, exactly-once dispatch, refresh-before-dispatch, and fail-open integration tests.
- `scripts/test-runtime-pack-release-matrix.mjs` — release-target artifact/lock completeness gate.

**Modify**

- `resources/runtime/requirements-runtime.txt` — declare direct Python imports explicitly.
- `src/main/runtime-pack-preflight.js` — consume readiness plans and stop treating every enabled preset skill as an eager install request.
- `src/main/runtime-pack-installer.js` — delegate download mechanics, run health before activation, and persist exact artifact metadata.
- `src/main/runtime-pack-specs.js` — add required/enhancement policy metadata without duplicating skill identities.
- `src/main/turn-orchestrator.js` — insert the pre-dispatch readiness barrier while preserving one admitted turn and one dispatch.
- `src/main/ipc-utils.js` / `src/main/runner-live-config.js` — rebuild a not-yet-dispatched runner after capability preparation.
- `src/main/mcp-config.js` — verify MCP registration from the refreshed runtime state.
- `src/renderer/modules/skill-preset-guide.js` — apply skills immediately without installing runtime packs.
- `src/renderer/modules/runtime-pack-progress.js` — show all active phases, grouped by turn/job, plus success and degraded fallback.
- `src/preload.js` — preserve the existing progress subscription API; extend payload only, no new renderer authority.
- `scripts/release-preflight.mjs` — run the release matrix gate.
- `scripts/test-runtime-pack-preflight.mjs`, `scripts/test-skill-presets.mjs`, `scripts/test-runtime-pack-main-progress-ui.mjs`, `scripts/test-runtime-pack-installer.mjs`, `scripts/test-turn-orchestrator.mjs`, `scripts/test-capability-grading.mjs`, `scripts/test-mcp-config.mjs` — regression coverage.
- `CAPABILITY-GATE.md` and `memory/office-runtime-delegation.md` — register the new non-regression rules and operational source of truth.

## Task 1: Lock model-capability invariants before changing dependency flow

**Files:**
- Modify: `scripts/test-capability-grading.mjs`
- Modify: `scripts/test-mcp-config.mjs`
- Modify: `CAPABILITY-GATE.md`

- [ ] **Step 1: Add a failing executable-surface equality assertion**

In `scripts/test-capability-grading.mjs`, compare normalized server names and entries for the same runtime input:

```js
const baselineServers = realPool._opencodeMcpServers(null, {});
for (const grade of ["lite", "standard", "full"]) {
  const gradedServers = realPool._opencodeMcpServers(null, { capabilityGrade: grade });
  assert.deepEqual(
    gradedServers,
    baselineServers,
    `${grade} must retain the complete strong-default executable MCP surface`,
  );
}
```

Add an assertion that tool-compat mode only renames known keys and preserves the count:

```js
const compat = realPool._opencodeMcpServers(null, { capabilityGrade: "lite", toolCompat: true });
assert.equal(Object.keys(compat).length, Object.keys(baselineServers).length);
assert.ok(compat.lily_tb && compat.lily_fi);
```

- [ ] **Step 2: Run the focused test and verify the guard is active**

Run:

```bash
export PATH="/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node scripts/test-capability-grading.mjs
```

Expected: PASS on the current additive implementation. Temporarily changing the lite MCP result to a subset must make this assertion fail; restore immediately.

- [ ] **Step 3: Add the refreshed-browser-state invariant**

In `scripts/test-mcp-config.mjs`, keep the explicit-context check and add the absent/present pair:

```js
writeActiveMcpConfig(empty, noBrowserOut, [], { platformOnly: true, activeSkillIds: [] });
const noBrowserContext = JSON.parse(
  JSON.parse(fs.readFileSync(noBrowserOut, "utf8")).mcpServers.lily_tool_broker.env.LILY_TOOL_BROKER_CONTEXT,
);
assert(noBrowserContext.runtime.browserAvailable === false, "missing Playwright reports false");

writeActiveMcpConfig(full, browserOut, [], { platformOnly: true, activeSkillIds: [] });
const browserContext = JSON.parse(
  JSON.parse(fs.readFileSync(browserOut, "utf8")).mcpServers.lily_tool_broker.env.LILY_TOOL_BROKER_CONTEXT,
);
assert(browserContext.runtime.browserAvailable === true, "registered Playwright reports true");
```

- [ ] **Step 4: Register the invariant in the capability gate**

Add a row to `CAPABILITY-GATE.md` stating that task-aware dependency preparation may add readiness context but cannot change the selected model, shared base prompt, context ceiling, executable MCP set, or raw fallback dispatch.

- [ ] **Step 5: Run both guards and commit**

Run:

```bash
node scripts/test-capability-grading.mjs
node scripts/test-mcp-config.mjs
```

Expected: both exit 0.

Commit:

```bash
git add scripts/test-capability-grading.mjs scripts/test-mcp-config.mjs CAPABILITY-GATE.md
git commit -m "test: lock additive model capability surface"
```

## Task 2: Introduce pure capability-readiness planning

**Files:**
- Create: `src/main/capability-readiness.js`
- Create: `scripts/test-capability-readiness.mjs`
- Modify: `src/main/runtime-pack-specs.js`
- Modify: `src/main/runtime-pack-preflight.js`

- [ ] **Step 1: Write failing planner tests**

Create `scripts/test-capability-readiness.mjs` with these cases:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  planCapabilityReadiness,
  resolveCapabilityReadiness,
} = require("../src/main/capability-readiness.js");

const browser = planCapabilityReadiness({ text: "打开 localhost 截图并检查控制台", files: [] });
assert.deepEqual(browser.requiredPackIds, ["web-automation"]);
assert.deepEqual(browser.enhancementPackIds, []);
assert.equal(browser.fallbackCapabilityIds.includes("code-static-review"), true);

const simplePdf = planCapabilityReadiness({ text: "总结这份 PDF", files: [{ name: "a.pdf" }] });
assert.deepEqual(simplePdf.requiredPackIds, []);
assert.equal(simplePdf.enhancementPackIds.includes("pro-pdf"), true);
assert.equal(simplePdf.enhancementPackIds.includes("large-document"), true);

const complexPdf = planCapabilityReadiness({
  text: "恢复复杂 PDF 的表格结构和阅读顺序",
  files: [{ name: "layout.pdf" }],
});
assert.equal(complexPdf.requiredPackIds.includes("pro-pdf"), true);

const ready = resolveCapabilityReadiness(browser, {
  installedPackIds: new Set(["web-automation"]),
  installingPackIds: new Set(),
  unavailablePackIds: new Set(),
});
assert.equal(ready.status, "ready");

const missing = resolveCapabilityReadiness(browser, {
  installedPackIds: new Set(),
  installingPackIds: new Set(),
  unavailablePackIds: new Set(),
});
assert.equal(missing.status, "preparing");
assert.deepEqual(missing.missingRequiredPackIds, ["web-automation"]);

const unavailable = resolveCapabilityReadiness(browser, {
  installedPackIds: new Set(),
  installingPackIds: new Set(),
  unavailablePackIds: new Set(["web-automation"]),
});
assert.equal(unavailable.status, "degraded");

console.log("capability-readiness: ok");
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node scripts/test-capability-readiness.mjs`

Expected: FAIL with `Cannot find module '../src/main/capability-readiness.js'`.

- [ ] **Step 3: Implement the minimal pure planner**

Create `src/main/capability-readiness.js` exporting stable shapes:

```js
"use strict";

const path = require("node:path");

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function planCapabilityReadiness({ text = "", files = [] } = {}) {
  const body = String(text || "");
  const extensions = new Set((files || []).map((file) => path.extname(file?.name || file?.path || "").toLowerCase()));
  const browser = /localhost|截图|控制台|浏览器|playwright|browser|responsive|响应式/i.test(body);
  const pdf = extensions.has(".pdf") || /\bpdf\b/i.test(body);
  const complexPdf = pdf && /复杂|版面|阅读顺序|表格结构|layout|reading order|table structure/i.test(body);

  return {
    capabilityIds: unique([
      browser ? "browser-qa" : "",
      pdf ? "pdf-read" : "",
      complexPdf ? "pdf-layout" : "",
    ]),
    requiredPackIds: unique([
      browser ? "web-automation" : "",
      complexPdf ? "pro-pdf" : "",
    ]),
    enhancementPackIds: unique(pdf && !complexPdf ? ["large-document", "pro-pdf"] : []),
    fallbackCapabilityIds: unique([
      browser ? "code-static-review" : "",
      pdf ? "bundled-pdf-extraction" : "",
    ]),
  };
}

function resolveCapabilityReadiness(plan, state) {
  const installed = state?.installedPackIds || new Set();
  const installing = state?.installingPackIds || new Set();
  const unavailable = state?.unavailablePackIds || new Set();
  const required = plan?.requiredPackIds || [];
  const missingRequiredPackIds = required.filter((id) => !installed.has(id) && !unavailable.has(id));
  const unavailablePackIds = required.filter((id) => unavailable.has(id));
  const installingPackIds = required.filter((id) => installing.has(id));
  const status = unavailablePackIds.length
    ? "degraded"
    : missingRequiredPackIds.length || installingPackIds.length
      ? "preparing"
      : "ready";
  return {
    status,
    missingRequiredPackIds,
    missingEnhancementPackIds: (plan?.enhancementPackIds || []).filter((id) => !installed.has(id)),
    installingPackIds,
    unavailablePackIds,
    refreshRequired: required.some((id) => !installed.has(id)),
  };
}

module.exports = { planCapabilityReadiness, resolveCapabilityReadiness };
```

Expand only with existing Office/OCR/media patterns from `runtime-pack-preflight.js`; do not introduce model calls in this module.

- [ ] **Step 4: Make legacy preflight consume the plan**

Change `inferRuntimePackIds(payload)` to return `unique([...plan.requiredPackIds, ...plan.enhancementPackIds])` for backward-compatible settings/diagnostics, and add `planRuntimePacks(payload)` returning the full required/enhancement split. Stop adding all packs solely because `presetId` or enabled skill IDs include a broad preset.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node scripts/test-capability-readiness.mjs
node scripts/test-runtime-pack-preflight.mjs
node scripts/test-capability-broker.mjs
```

Expected: all exit 0.

Commit:

```bash
git add src/main/capability-readiness.js src/main/runtime-pack-preflight.js src/main/runtime-pack-specs.js scripts/test-capability-readiness.mjs scripts/test-runtime-pack-preflight.mjs
git commit -m "feat: plan task-scoped capability readiness"
```

## Task 3: Make skill presets dependency-lazy

**Files:**
- Modify: `src/renderer/modules/skill-preset-guide.js`
- Modify: `src/renderer/modules/runtime-pack-preflight-ui.js`
- Modify: `scripts/test-skill-presets.mjs`
- Modify: `scripts/test-runtime-pack-main-progress-ui.mjs`

- [ ] **Step 1: Add a failing preset contract test**

In `scripts/test-skill-presets.mjs`, read the renderer source and assert:

```js
const guideSource = fs.readFileSync(path.join(ROOT, "src/renderer/modules/skill-preset-guide.js"), "utf8");
assert.doesNotMatch(
  guideSource,
  /installMissingRuntimePacks\(getMissingPacks\(\)\)/,
  "applying a skill preset must not eagerly install optional runtime packs",
);
assert.match(guideSource, /applySkillPreset\(presetId\)/);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-skill-presets.mjs`

Expected: FAIL because `applyGuidePreset` currently installs every missing preset pack before applying skills.

- [ ] **Step 3: Remove eager installation from preset apply**

Change `applyGuidePreset` to:

```js
async function applyGuidePreset(applyBtn, presetId) {
  if (anySessionRunning()) {
    showToast(t("toast.sessionSkillsBusy"), "error");
    return false;
  }
  applyBtn.disabled = true;
  const result = await window.assistantClient.applySkillPreset(presetId);
  applyBtn.disabled = false;
  if (!result.ok) {
    showToast(skillErrorMessage(result.error), "error");
    return false;
  }
  await window.assistantClient.setSkillPresetGuideStatus("applied");
  showToast(t("toast.skillsPresetApplied", { name: t(`skills.preset.${presetId}.title`) }), "success");
  handlePresetApplyResult(result);
  await refreshSkillsList();
  return true;
}
```

Keep dependency descriptions informational; change the CTA back to the ordinary apply label because installation is task-triggered.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node scripts/test-skill-presets.mjs
node scripts/test-runtime-pack-main-progress-ui.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: all exit 0.

Commit:

```bash
git add src/renderer/modules/skill-preset-guide.js src/renderer/modules/runtime-pack-preflight-ui.js scripts/test-skill-presets.mjs scripts/test-runtime-pack-main-progress-ui.mjs
git commit -m "fix: keep skill presets dependency-lazy"
```

## Task 4: Add resumable and space-aware runtime-pack downloads

**Files:**
- Create: `src/main/runtime-pack-download.js`
- Create: `scripts/test-runtime-pack-download.mjs`
- Modify: `src/main/runtime-pack-installer.js`
- Modify: `scripts/test-runtime-pack-installer.mjs`

- [ ] **Step 1: Write a local-server failing test**

Create a local HTTP server that serves a deterministic buffer, honors `Range`, fails the first request after a partial body, and records headers. Assert:

```js
const result = await downloadArtifact({
  url: serverUrl,
  partPath,
  expectedBytes: payload.length,
  maxBytes: payload.length + 1024,
  maxAttempts: 3,
  freeBytes: async () => payload.length * 3,
});
assert.equal(result.ok, true);
assert.equal(fs.readFileSync(partPath).equals(payload), true);
assert.equal(requests.some((request) => request.range === `bytes=${partialBytes}-`), true);
assert.equal(result.resumed, true);
```

Add a second case where `freeBytes()` returns less than `expectedBytes * 2` and assert `{ ok:false, error:"INSUFFICIENT_DISK_SPACE" }` before any request.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-runtime-pack-download.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement the downloader**

Export:

```js
async function downloadArtifact({
  url,
  partPath,
  expectedBytes = 0,
  maxBytes,
  maxAttempts = 3,
  freeBytes = availableBytesForPath,
  onProgress,
})
```

Requirements:

- use `fs.statfsSync(path.dirname(partPath)).bavail * bsize` when available;
- send `Range: bytes=<existing>-` when `.part` exists;
- accept `206` for resume and restart safely on a `200` response that ignores Range;
- preserve `.part` on transport failure;
- delete `.part` on size overflow or explicit checksum failure by the caller;
- retry network/5xx/408/429 with delays `250ms`, `750ms`, `1750ms` plus bounded jitter;
- never retry 4xx other than 408/429;
- emit `writtenBytes`, `totalBytes`, `attempt`, and `resumed`.

- [ ] **Step 4: Wire installer staging to the downloader**

Replace the nonce archive with a stable per-artifact partial path derived from pack/version/hash:

```js
const artifactKey = crypto.createHash("sha256")
  .update(`${id}\0${artifact.version || ""}\0${artifact.sha256 || artifact.url}`)
  .digest("hex")
  .slice(0, 20);
const archivePath = path.join(cacheDir, `.${id}-${artifactKey}.pack${archiveExtensionForArtifact(artifact)}`);
const partPath = `${archivePath}.part`;
```

Rename `.part` to the archive only after the declared byte count is reached. Keep checksum verification and staging extraction.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node scripts/test-runtime-pack-download.mjs
node scripts/test-runtime-pack-installer.mjs
node scripts/test-runtime-pack-location.mjs
```

Expected: all exit 0.

Commit:

```bash
git add src/main/runtime-pack-download.js src/main/runtime-pack-installer.js scripts/test-runtime-pack-download.mjs scripts/test-runtime-pack-installer.mjs
git commit -m "feat: resume runtime pack downloads safely"
```

## Task 5: Coordinate required-pack preparation and health activation

**Files:**
- Create: `src/main/runtime-pack-coordinator.js`
- Create: `scripts/test-runtime-pack-coordinator.mjs`
- Modify: `src/main/runtime-pack-installer.js`
- Modify: `src/main/runtime-health.js`

- [ ] **Step 1: Write failing coordinator tests**

Use injected dependencies and assert:

```js
const coordinator = createRuntimePackCoordinator({
  maxConcurrent: 2,
  installer: async (id) => {
    active += 1;
    peak = Math.max(peak, active);
    await tick();
    active -= 1;
    return { ok: id !== "bad", id, error: id === "bad" ? "NO_RUNTIME_PACK_ARTIFACT" : undefined };
  },
  health: async (id) => ({ ok: id !== "unhealthy", id }),
});

const [first, joined] = await Promise.all([
  coordinator.prepare({ turnId: "t1", requiredPackIds: ["web-automation", "ffmpeg"] }),
  coordinator.prepare({ turnId: "t2", requiredPackIds: ["web-automation"] }),
]);
assert.equal(peak <= 2, true);
assert.equal(installCalls.filter((id) => id === "web-automation").length, 1);
assert.deepEqual(first.readyPackIds.sort(), ["ffmpeg", "web-automation"]);
assert.deepEqual(joined.readyPackIds, ["web-automation"]);
```

Add failure assertions for `failedPackIds`, `unavailablePackIds`, and `refreshRequired:false` when nothing new installed.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-runtime-pack-coordinator.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement bounded global coordination**

Export `createRuntimePackCoordinator(deps)` and singleton `runtimePackCoordinator`. `prepare()` returns:

```js
{
  ok,
  turnId,
  readyPackIds,
  installedPackIds,
  failedPackIds,
  unavailablePackIds,
  refreshRequired,
  failures,
}
```

Use a module-level/in-instance `jobsByPackId` map so callers join the same install promise. The coordinator owns concurrency; the installer remains idempotent.

- [ ] **Step 4: Require health before activation**

In `runRuntimePackInstall`, extract into staging, run `checkRuntimePackHealthAtPath(id, stagingPath)`, and only then call `replacePackDirectory`. Persist health metadata:

```js
state.installed[id] = {
  installedAt: new Date().toISOString(),
  source: "artifact",
  version: artifact.version || null,
  sha256: artifact.sha256 || null,
  sizeBytes: Number(artifact.sizeBytes || artifact.size || 0),
  healthCheckedAt: new Date().toISOString(),
  format,
};
```

If health fails, delete staging, preserve the prior installed directory, and return `RUNTIME_PACK_HEALTH_FAILED`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node scripts/test-runtime-pack-coordinator.mjs
node scripts/test-runtime-pack-installer.mjs
node scripts/test-runtime-health.mjs
```

Expected: all exit 0.

Commit:

```bash
git add src/main/runtime-pack-coordinator.js src/main/runtime-pack-installer.js src/main/runtime-health.js scripts/test-runtime-pack-coordinator.mjs scripts/test-runtime-pack-installer.mjs scripts/test-runtime-health.mjs
git commit -m "feat: coordinate healthy runtime pack activation"
```

## Task 6: Add the exactly-once pre-dispatch readiness barrier

**Files:**
- Create: `scripts/test-turn-dependency-readiness.mjs`
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/ipc-utils.js`
- Modify: `src/main/runner-live-config.js`
- Modify: `scripts/test-turn-orchestrator.mjs`

- [ ] **Step 1: Write failing turn integration tests**

Build a fake session manager, runner pool, runner, and coordinator. Cover these assertions:

```js
assert.equal(events[0].type, "user.committed", "user input is visible before dependency preparation");
assert.deepEqual(order, ["admit", "prepare", "refresh", "ensure-runner", "dispatch"]);
assert.equal(fakeRunner.payloads.length, 1, "prepared turn dispatches exactly once");
assert.equal(fakeRunner.payloads[0].trace.capabilityReadiness.status, "ready");
```

Failure case:

```js
coordinator.prepare = async () => ({
  ok: false,
  failedPackIds: ["web-automation"],
  unavailablePackIds: ["web-automation"],
  refreshRequired: false,
});
const result = await orchestrator.sendUserMessage(sessionId, "打开页面截图");
assert.equal(result.ok, true);
assert.equal(fakeRunner.payloads.length, 1);
assert.equal(fakeRunner.payloads[0].trace.capabilityReadiness.status, "degraded");
assert.match(fakeRunner.payloads[0].text, /browser evidence is unavailable/i);
```

Planner exception case must produce the original baseline engine text and one dispatch.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-turn-dependency-readiness.mjs`

Expected: FAIL because no readiness barrier exists.

- [ ] **Step 3: Split admission from runner dispatch**

Extract two private methods from `_startTurn` without changing existing behavior:

```js
_admitTurn(session, rawUserText, files, opts) -> { state, displayFiles, turnId }
_dispatchAdmittedTurn(session, admitted, opts) -> Promise<{ ok, turnId }>
```

`_admitTurn` initializes state, persists `admitTurnInput`, commits the user message, and emits `user.committed`. It must not create or call a runner.

- [ ] **Step 4: Insert readiness before ensureSessionRunner**

Inside `_dispatchAdmittedTurn`:

```js
let readinessTrace = null;
try {
  const plan = planCapabilityReadiness({ text: rawUserText, files });
  const readiness = resolveCapabilityReadiness(plan, {
    installedPackIds: installedRuntimePackIds(),
    installingPackIds: installingRuntimePackIds(),
    unavailablePackIds: new Set(),
  });
  if (readiness.missingRequiredPackIds.length) {
    const prepared = await runtimePackCoordinator.prepare({
      turnId: state.turnId,
      requiredPackIds: readiness.missingRequiredPackIds,
    });
    readinessTrace = {
      status: prepared.ok ? "ready" : "degraded",
      requiredPackIds: plan.requiredPackIds,
      enhancementPackIds: plan.enhancementPackIds,
      readyPackIds: prepared.readyPackIds,
      failedPackIds: prepared.failedPackIds,
      unavailablePackIds: prepared.unavailablePackIds,
      fallbackCapabilityIds: plan.fallbackCapabilityIds,
    };
    if (prepared.refreshRequired) {
      refreshPreparedRuntimeForTurn(this.ctx, session.id);
    }
  } else {
    readinessTrace = {
      status: readiness.status,
      requiredPackIds: plan.requiredPackIds,
      enhancementPackIds: plan.enhancementPackIds,
      readyPackIds: plan.requiredPackIds,
      failedPackIds: [],
      unavailablePackIds: readiness.unavailablePackIds,
      fallbackCapabilityIds: plan.fallbackCapabilityIds,
    };
  }
} catch (error) {
  readinessTrace = { status: "baseline", error: error?.message || String(error) };
}
```

Only after this block call `ensureSessionRunner`. Add `trace.capabilityReadiness = readinessTrace` and bounded degraded context when required packs failed.

- [ ] **Step 5: Implement pre-dispatch runner refresh**

Add to `runner-live-config.js`:

```js
function refreshPreparedRuntimeForTurn(ctx, sessionId) {
  const runner = ctx?.runnerPool?.get?.(sessionId);
  if (runner?.isBusy?.()) throw new Error("RUNNER_ALREADY_BUSY_BEFORE_DISPATCH");
  if (runner?.isAlive?.()) ctx.runnerPool.terminateSession(sessionId);
  return { refreshed: true, sessionId };
}
```

This function is valid only before first dispatch. Never terminate a runner that has accepted the current payload.

- [ ] **Step 6: Verify exactly-once and fail-open behavior**

Run:

```bash
node scripts/test-turn-dependency-readiness.mjs
node scripts/test-turn-orchestrator.mjs
node scripts/test-session-runner-pool-skill-scope.mjs
node scripts/test-mcp-config.mjs
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/main/turn-orchestrator.js src/main/ipc-utils.js src/main/runner-live-config.js scripts/test-turn-dependency-readiness.mjs scripts/test-turn-orchestrator.mjs
git commit -m "feat: prepare task capabilities before one dispatch"
```

## Task 7: Show complete chat-native preparation progress

**Files:**
- Modify: `src/main/runtime-pack-installer.js`
- Modify: `src/main/runtime-pack-coordinator.js`
- Modify: `src/renderer/modules/runtime-pack-progress.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `src/renderer/styles/overlays.css`
- Modify: `scripts/test-runtime-pack-main-progress-ui.mjs`
- Modify: `scripts/test-renderer-import.cjs`

- [ ] **Step 1: Change the static test to require active phases**

In `scripts/test-runtime-pack-main-progress-ui.mjs`, replace the failed-only assertion with:

```js
assert.match(progressUi, /ACTIVE_VISIBLE_PHASES/);
for (const phase of ["resolving", "downloading", "verifying", "extracting", "health-checking", "refreshing", "installed", "failed"]) {
  assert.match(progressUi, new RegExp(`\\b${phase.replace("-", "\\-")}\\b`));
}
assert.doesNotMatch(progressUi, /MAIN_VISIBLE_PHASES = new Set\(\["failed"\]\)/);
```

Add locale assertions for `runtimeProgress.preparing`, `runtimeProgress.refreshing`, `runtimeProgress.ready`, and `runtimeProgress.degraded`.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/test-runtime-pack-main-progress-ui.mjs`

Expected: FAIL because active phases are currently hidden.

- [ ] **Step 3: Extend progress payloads with task identity**

Coordinator/installer progress must preserve:

```js
{
  id,
  jobId,
  turnId,
  phase,
  writtenBytes,
  totalBytes,
  attempt,
  resumed,
  at,
}
```

The installer remains usable without a turn ID; settings installs may use `turnId:""`.

- [ ] **Step 4: Render active, success, and degraded phases**

Use:

```js
const ACTIVE_VISIBLE_PHASES = new Set([
  "resolving",
  "downloading",
  "verifying",
  "extracting",
  "health-checking",
  "refreshing",
  "installed",
  "failed",
]);
```

Display one compact strip for the newest active turn, show count when more than one pack participates, keep failure until dismissed/next turn, and collapse success after 2600ms. Preserve `role="status"` and `aria-live="polite"`; Arabic must remain RTL through the existing document locale direction.

- [ ] **Step 5: Verify renderer and commit**

Run:

```bash
node scripts/test-runtime-pack-main-progress-ui.mjs
npx electron scripts/test-renderer-import.cjs
node scripts/test-i18n-non-zh-leaks.mjs
```

Expected: all exit 0.

Commit:

```bash
git add src/main/runtime-pack-installer.js src/main/runtime-pack-coordinator.js src/renderer/modules/runtime-pack-progress.js src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json src/renderer/styles/overlays.css scripts/test-runtime-pack-main-progress-ui.mjs scripts/test-renderer-import.cjs
git commit -m "feat: show dependency readiness through completion"
```

## Task 8: Make runtime dependency builds reproducible and release-gated

**Files:**
- Modify: `resources/runtime/requirements-runtime.txt`
- Create: `resources/runtime/runtime-pack-lock.json`
- Create: `scripts/test-runtime-pack-release-matrix.mjs`
- Modify: `scripts/build-runtime-pack.mjs`
- Modify: `scripts/publish-common-runtime-pack.mjs`
- Modify: `scripts/release-preflight.mjs`
- Modify: `scripts/test-runtime-release-policy.mjs`

- [ ] **Step 1: Add direct runtime dependencies**

Add compatible direct declarations:

```text
python-pptx>=1.0,<2
pdfplumber>=0.11,<1
```

Keep `markitdown[pptx,pdf,docx]`; these direct lines document imports used by `extract_document.py` rather than relying on extras transitively.

- [ ] **Step 2: Write a failing lock/matrix test**

The test must load `PACK_SPECS`, `runtime-pack-lock.json`, and release targets `darwin-arm64`, `darwin-x64`, `win32-x64`. Assert every pack classified as release-required has exactly one enabled lock entry per release target with:

```js
assert.equal(typeof entry.version, "string");
assert.match(entry.sha256, /^[a-f0-9]{64}$/);
assert.equal(Number.isInteger(entry.sizeBytes) && entry.sizeBytes > 0, true);
assert.equal(typeof entry.healthProbe, "string");
```

For `web-automation`, assert exact `components.playwright`, `components["@playwright/mcp"]`, and `components.chromiumRevision` values.

- [ ] **Step 3: Run and verify RED**

Run: `node scripts/test-runtime-pack-release-matrix.mjs`

Expected: FAIL because the lock file does not exist.

- [ ] **Step 4: Generate lock entries from build output**

Both publisher scripts must write/update the lock only after local probe success and artifact hash calculation. Use stable key ordering by `packId`, then `platform`; never hand-edit generated hash/version data. A common helper may be added to `scripts/lib/runtime-pack-lock.mjs` if both scripts would otherwise duplicate serialization.

- [ ] **Step 5: Add production artifact verification mode**

`scripts/test-runtime-pack-release-matrix.mjs --online` must query `/api/runtime-packs/artifact` with bounded retry and compare URL metadata to the lock. Offline default validates the checked-in lock only. `release-preflight.mjs` runs offline always and online when `LILY_RELEASE_ONLINE_PREFLIGHT=1` or during one-click upload.

- [ ] **Step 6: Populate only verified entries**

Build/publish missing `darwin-x64` artifacts on an Intel macOS host. Do not copy ARM or Windows hashes into the lock. Until all release-required entries exist, the matrix test must remain red and the release must remain blocked.

- [ ] **Step 7: Verify and commit**

Run:

```bash
node scripts/test-runtime-pack-release-matrix.mjs
node scripts/test-runtime-release-policy.mjs
node scripts/release-preflight.mjs
```

Expected: all exit 0 only after verified three-platform lock coverage exists.

Commit:

```bash
git add resources/runtime/requirements-runtime.txt resources/runtime/runtime-pack-lock.json scripts/build-runtime-pack.mjs scripts/publish-common-runtime-pack.mjs scripts/test-runtime-pack-release-matrix.mjs scripts/release-preflight.mjs scripts/test-runtime-release-policy.mjs
git commit -m "build: gate reproducible runtime pack matrix"
```

## Task 9: Complete platform verification and operational documentation

**Files:**
- Modify: `CAPABILITY-GATE.md`
- Modify: `memory/office-runtime-delegation.md`
- Modify: `docs/capability-grading-plan.md`
- Test: all focused tests and `npm run test:unit`

- [ ] **Step 1: Register all new regression vectors**

Add capability-gate rows for:

- presets triggering heavyweight eager installs;
- dependency installs succeeding but not becoming visible to the current runner/MCP;
- preparation dispatching the same user message twice;
- partial downloads restarting from zero;
- artifact catalogs advertising unavailable platform builds;
- lite models losing executable surfaces;
- strong models receiving altered base config or reduced context.

- [ ] **Step 2: Update operational memory**

Document the source-of-truth chain:

```text
capability-readiness plan
  -> runtime-pack coordinator
  -> installer/download/health
  -> runner + MCP refresh
  -> one turn dispatch
  -> evidence/verification
```

State explicitly that skill presets never install runtime packs and that online artifact coverage is a release concern, not something the user repairs manually.

- [ ] **Step 3: Run focused capability and first-use tests**

Run:

```bash
export PATH="/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node scripts/test-capability-readiness.mjs
node scripts/test-runtime-pack-preflight.mjs
node scripts/test-runtime-pack-download.mjs
node scripts/test-runtime-pack-coordinator.mjs
node scripts/test-runtime-pack-installer.mjs
node scripts/test-turn-dependency-readiness.mjs
node scripts/test-turn-orchestrator.mjs
node scripts/test-mcp-config.mjs
node scripts/test-capability-grading.mjs
node scripts/test-runtime-pack-main-progress-ui.mjs
node scripts/test-runtime-pack-release-matrix.mjs
```

Expected: all exit 0.

- [ ] **Step 4: Run the complete suite**

Run: `npm run test:unit`

Expected: `390/390` or the then-current auto-discovered total, with zero failures. If the known timing-sensitive `test-opencode-agent-session.mjs` fails, run it alone to classify reproducibility, then rerun the full suite; do not report completion until a fresh full run is green.

- [ ] **Step 5: Inspect final repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline -12
```

Expected: no uncommitted implementation files; preserve the user-owned `.superpowers/` directory if still untracked.

- [ ] **Step 6: Commit documentation**

```bash
git add CAPABILITY-GATE.md memory/office-runtime-delegation.md docs/capability-grading-plan.md
git commit -m "docs: govern task-aware capability readiness"
```

## Execution checkpoints

- After Tasks 1-3: presets are instant and model capability surfaces are locked, but no automatic installation behavior has changed yet.
- After Tasks 4-5: installation is resumable, health-checked, deduplicated, and bounded, still not connected to turn dispatch.
- After Tasks 6-7: first-use tasks prepare required capabilities visibly and dispatch exactly once through a refreshed runner/MCP.
- After Tasks 8-9: production builds are reproducible and cannot advertise missing release-target artifacts.

At every checkpoint, if the new path is disabled or throws, the original strong-default turn path must remain operational.
