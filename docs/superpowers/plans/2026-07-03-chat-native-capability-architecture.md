# Chat-Native Capability Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Lily Workbench smarter by moving business operations into chat-native agent execution while keeping UI as observability, safety, and account/config infrastructure only.

**Architecture:** Add a single capability-broker layer above existing skills, MCP tools, runtime packs, process jobs, file intelligence, learned playbooks, and evidence ledger. The broker exposes compact, typed, agent-invocable capabilities to the model; deterministic code still performs installs, extraction, indexing, scans, media probing, exports, and verification. Every new path must degrade to today's strong default when unavailable.

**Tech Stack:** Electron main process CommonJS modules, renderer chat/tool-card modules, existing `lily_process_jobs` MCP, first-party `lily-*` skills, runtime-pack catalog, Node test scripts under `scripts/test-*.mjs`, Electron renderer regression test `scripts/test-renderer-import.cjs`.

---

## Product Boundary

Lily is not becoming a file-processing app, dependency manager UI, browser automation UI, or admin dashboard product. Lily is a conversational workbench. The platform supplies reliable substrates; the agent chooses and invokes them from natural language.

Keep these invariants through every task:

- Chat is the operation entry point.
- UI surfaces state, evidence, artifacts, risk confirmations, account/security settings, and recovery actions.
- Skills are capability contracts, not one-off prompt hacks.
- Deterministic work stays in scripts/tools/MCP/runtime packs.
- Model judgment selects routes, interprets evidence, asks clarifying questions, and writes final answers.
- Failure never makes the assistant worse than the pre-change baseline.

## File Structure

- Create: `src/main/capability-broker.js`  
  Pure CommonJS capability registry and selector helpers. It gathers known platform capabilities from static definitions and small provider functions. It does not call Electron APIs directly.
- Modify: `src/main/turn-orchestrator.js`  
  Inject compact capability context and dependency/job guidance into each turn. Do not add blocking pre-send UI behavior.
- Modify: `src/main/task-contract.js`  
  Add intent hints that route operational requests to capability families without hardcoding one business workflow.
- Modify: `src/main/skill-manager.js`  
  Add platform guidance telling main and sub agents to use the brokered capabilities and to avoid UI-first workflows.
- Modify: `src/main/tool-broker-registry.js`  
  Ensure dependency-pack, process-job, file-intelligence, artifact, and learned-playbook tools have stable capability metadata.
- Modify: `src/main/runtime-pack-specs.js`  
  Add capability categories and trigger hints that are consumed by the broker, not by renderer UI.
- Modify: `src/main/mcp/process-jobs-core.js`  
  Ensure every managed job exposes progress phase, heartbeat, output file hints, and recoverable error status.
- Modify: `src/renderer/modules/message.js`  
  Render capability/job/evidence updates in chat without introducing new business panels.
- Modify: `src/renderer/modules/settings-panel.js`  
  Keep settings as health/config pages; remove or demote any blocking "do this here first" copy for operations that should be chat-native.
- Modify: `CAPABILITY-GATE.md`  
  Register guards for chat-native capability routing, non-blocking dependency resolution, and UI-as-observability boundary.
- Test: `scripts/test-capability-broker.mjs`
- Test: `scripts/test-chat-native-dependency-flow.mjs`
- Test: `scripts/test-process-job-observability.mjs`
- Test: `scripts/test-task-contract.mjs`
- Test: `scripts/test-skill-catalog.mjs`
- Test: `scripts/test-renderer-import.cjs`

---

### Task 1: Capability Broker Core

**Files:**
- Create: `src/main/capability-broker.js`
- Test: `scripts/test-capability-broker.mjs`

- [x] **Step 1: Write a failing test for stable capability registration**

Create `scripts/test-capability-broker.mjs` with this initial shape:

```js
const assert = require("node:assert/strict");
const { listCapabilities, compactCapabilityContext } = require("../src/main/capability-broker");

const capabilities = listCapabilities();
assert.ok(capabilities.some((item) => item.id === "dependency.install"));
assert.ok(capabilities.some((item) => item.id === "file.index"));
assert.ok(capabilities.some((item) => item.id === "process.job"));
assert.ok(capabilities.some((item) => item.id === "artifact.reveal"));

for (const item of capabilities) {
  assert.match(item.id, /^[a-z][a-z0-9.-]+$/);
  assert.ok(item.title);
  assert.ok(item.family);
  assert.ok(Array.isArray(item.triggers));
  assert.ok(item.failOpen);
}

const context = compactCapabilityContext({ maxChars: 2500 });
assert.ok(context.includes("dependency.install"));
assert.ok(context.includes("process.job"));
assert.ok(context.length <= 2500);

console.log("capability-broker: ok");
```

- [x] **Step 2: Run the test and verify it fails**

Run: `node scripts/test-capability-broker.mjs`  
Expected: FAIL with `Cannot find module '../src/main/capability-broker'`.

- [x] **Step 3: Implement the pure broker**

Create `src/main/capability-broker.js`:

```js
"use strict";

const BASE_CAPABILITIES = [
  {
    id: "dependency.install",
    family: "dependency",
    title: "Install or repair optional dependency packs",
    triggers: ["dependency missing", "install runtime", "large pdf", "ocr", "ffmpeg", "playwright"],
    route: "Use lily-runtime-packs skill or runtime pack MCP tools. Long installs must run through lily_process_jobs.",
    failOpen: "If unavailable, continue with bundled capabilities and state the missing pack.",
  },
  {
    id: "file.index",
    family: "file",
    title: "Index and query large files or folders",
    triggers: ["large document", "many files", "search within folder", "query pdf", "analyze workbook"],
    route: "Use file intelligence tools or document extraction scripts. Do not read huge files wholesale into prompt.",
    failOpen: "If indexing fails, use path-first CLI/file tools and disclose partial evidence.",
  },
  {
    id: "process.job",
    family: "execution",
    title: "Run long tasks with progress and recovery",
    triggers: ["long scan", "batch convert", "dependency install", "web learning", "video processing"],
    route: "Use lily_process_jobs job_start/job_status/job_logs for long deterministic work.",
    failOpen: "If the supervisor is unavailable, use foreground tools only and do not claim background progress.",
  },
  {
    id: "artifact.reveal",
    family: "artifact",
    title: "Register, preview, and reveal generated files",
    triggers: ["generated image", "open file location", "preview artifact", "show output"],
    route: "Use artifact registry/local media protocol and absolute file evidence.",
    failOpen: "If preview cannot render, show the path and keep reveal/copy affordances.",
  },
  {
    id: "web.learn",
    family: "web",
    title: "Learn a web system into a workspace skill",
    triggers: ["learn website", "learn admin system", "automate portal", "web app operation"],
    route: "Use lily-web-system-learning orchestrator; normal usage must prefer learned API/playbook execution.",
    failOpen: "If learning cannot authenticate or converge, produce a partial draft with gaps instead of ad-hoc browser loops.",
  },
];

function normalizeCapability(item) {
  return {
    id: String(item.id || "").trim(),
    family: String(item.family || "general").trim(),
    title: String(item.title || "").trim(),
    triggers: Array.isArray(item.triggers) ? item.triggers.map(String).filter(Boolean) : [],
    route: String(item.route || "").trim(),
    failOpen: String(item.failOpen || "Fall back to today's behavior.").trim(),
  };
}

function listCapabilities(extra = []) {
  return [...BASE_CAPABILITIES, ...extra].map(normalizeCapability).filter((item) => item.id && item.title);
}

function compactCapabilityContext(opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(500, opts.maxChars) : 4000;
  const lines = [
    "Lily chat-native capabilities:",
    ...listCapabilities(opts.extra).map(
      (item) => `- ${item.id}: ${item.title}. Route: ${item.route} Fail-open: ${item.failOpen}`
    ),
  ];
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 24))}\n[capabilities truncated]`;
}

module.exports = {
  listCapabilities,
  compactCapabilityContext,
};
```

- [x] **Step 4: Run the test and verify it passes**

Run: `node scripts/test-capability-broker.mjs`  
Expected: `capability-broker: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/main/capability-broker.js scripts/test-capability-broker.mjs
git commit -m "Add chat-native capability broker"
```

### Task 2: Inject Capability Context Into Turns Without Blocking UI

**Files:**
- Modify: `src/main/turn-orchestrator.js`
- Test: `scripts/test-chat-native-dependency-flow.mjs`

- [x] **Step 1: Write a failing test for non-blocking capability context**

Create `scripts/test-chat-native-dependency-flow.mjs`:

```js
const assert = require("node:assert/strict");
const { compactCapabilityContext } = require("../src/main/capability-broker");

const context = compactCapabilityContext({ maxChars: 3000 });
assert.ok(context.includes("dependency.install"));
assert.ok(context.includes("lily_process_jobs"));
assert.ok(!context.includes("Open Settings first"));
assert.ok(!context.includes("block the user"));

console.log("chat-native-dependency-flow: ok");
```

- [x] **Step 2: Run the test and verify it fails if Task 1 is not present**

Run: `node scripts/test-chat-native-dependency-flow.mjs`  
Expected before Task 1: module missing. Expected after Task 1: PASS.

- [x] **Step 3: Inject broker context into platform context**

In `src/main/turn-orchestrator.js`, import:

```js
const { compactCapabilityContext } = require("./capability-broker");
```

In the turn platform-context assembly where existing dependency advisory is appended, add a bounded capability block:

```js
const capabilityContext = compactCapabilityContext({ maxChars: 3000 });
if (capabilityContext) platformContextParts.push(capabilityContext);
```

Keep this block low priority behind direct user text and extracted attachment evidence. Do not block `sendMessage`, do not open settings, and do not trigger installs from the renderer.

- [x] **Step 4: Verify existing fast path still works**

Run:

```bash
node scripts/test-chat-native-dependency-flow.mjs
node scripts/test-runtime-boundary.mjs
node scripts/test-turn-artifacts.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/turn-orchestrator.js scripts/test-chat-native-dependency-flow.mjs
git commit -m "Expose chat-native capabilities to agent turns"
```

### Task 3: Convert Dependency UX From Blocking Prompt To Agent-Advisory

**Files:**
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/renderer/modules/settings-panel.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Test: `scripts/test-chat-native-dependency-flow.mjs`
- Test: `scripts/test-renderer-import.cjs`

- [x] **Step 1: Add assertions that dependency guidance is advisory**

Extend `scripts/test-chat-native-dependency-flow.mjs`:

```js
assert.ok(context.includes("continue with bundled capabilities"));
assert.ok(context.includes("Long installs must run through lily_process_jobs"));
```

- [ ] **Step 2: Remove any composer-level dependency prompt that blocks send**

Search:

```bash
rg -n "dependencyPrompt|dependencyInstallWaiting|runtime-packs:list|runtimepacks" src/renderer src/main
```

For composer/send code, remove logic that prevents the user message from being sent solely because a dependency is missing. Replace it with a non-blocking notice only if the renderer already has a status surface. The agent must receive the user's request plus dependency advisory and decide the route.

- [ ] **Step 3: Keep settings dependency pages as health views**

In `src/renderer/modules/settings-panel.js`, keep install/uninstall/status buttons only for explicit settings use. Copy should frame them as health/advanced controls, not as the required path for user tasks.

- [x] **Step 4: Run renderer and dependency tests**

Run:

```bash
node scripts/test-chat-native-dependency-flow.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: dependency test passes and renderer import ends with `test-renderer-import: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/main/turn-orchestrator.js src/renderer/modules/settings-panel.js src/renderer/i18n/locales scripts/test-chat-native-dependency-flow.mjs
git commit -m "Make dependency handling chat native"
```

### Task 4: Standardize Long Task Observability

**Files:**
- Modify: `src/main/mcp/process-jobs-core.js`
- Modify later: `src/renderer/modules/message.js`
- Test: `scripts/test-process-job-observability.mjs`
- Test: `scripts/test-process-jobs-core.mjs`

- [x] **Step 1: Write a failing process-job observability test**

Create `scripts/test-process-job-observability.mjs`:

```js
// Actual test starts a managed Node process, emits [lily-progress],
// preserves output file hints, and verifies normalized fields:
// status + state, phase, heartbeatAt, outputFiles, progress, recoverable.
```

- [x] **Step 2: Run the test and verify current gaps**

Run: `node scripts/test-process-job-observability.mjs`  
Expected before implementation: FAIL on missing `state`.

- [x] **Step 3: Normalize job status shape**

Ensure job status objects include these fields when known:

```js
{
  jobId,
  status,
  state,
  command,
  startedAt,
  updatedAt,
  phase,
  heartbeatAt,
  progress,
  outputFiles,
  error,
  recoverable
}
```

If a script only emits plain logs, infer `heartbeatAt` from registry/log timestamps and leave `phase` empty. Do not invent progress percentages.

- [x] **Step 4: Render job status in chat/tool cards**

Implemented in `src/renderer/modules/tool-payload-renderer.js` using the existing
chat tool-card detail renderer, not a new panel. Process job result payloads now
surface:

- running phase
- last heartbeat age
- latest progress line
- output files
- recoverable error and retry/reveal affordance

Do not add a separate business workflow panel.

- [x] **Step 5: Run backend process-job tests**

```bash
node scripts/test-process-job-observability.mjs
node scripts/test-process-jobs-core.mjs
node scripts/test-process-job-protocol.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/process-jobs-core.js src/main/store/runtime-event-persistence.js src/main/runtime-event-schema.js src/renderer/modules/message.js scripts/test-process-job-observability.mjs
git commit -m "Standardize chat-visible long task progress"
```

### Task 5: Make Skills First-Class Capability Contracts

**Files:**
- Modify: `src/main/skill-manager.js`
- Modify: `resources/skills-catalog/lily-runtime-packs/SKILL.md`
- Modify: `resources/skills-catalog/lily-office-intent/SKILL.md`
- Modify: `resources/skills-catalog/lily-web-system-learning/SKILL.md`
- Test: `scripts/test-skill-catalog.mjs`
- Test: `scripts/test-opencode-config-builder.mjs`

- [x] **Step 1: Add catalog assertions**

Extended `scripts/test-skill-capability-contracts.mjs` to assert first-party
operational skills mention:

- process job supervision for long tasks
- fail-open behavior
- no UI-first workflow
- no ad-hoc runtime installs when a Lily pack exists

- [x] **Step 2: Update base and subagent guidance**

In `src/main/skill-manager.js`, add concise guidance:

```text
Use Lily capability contracts before inventing a workflow. For dependency, document, media, web-learning, file-indexing, export/import, and artifact tasks, route through the relevant skill/tool/script and keep progress observable in chat. Do not tell the user to go click a UI first unless the task is account/security/billing setup or explicit manual confirmation.
```

Subagents get the same rule plus: return the capability used, evidence files, and remaining gaps.

- [x] **Step 3: Update first-party skills**

Keep the existing skill content but ensure each one states:

- how to start from natural language
- dependency route
- long task supervision route
- evidence output
- failure recovery

- [x] **Step 4: Run tests**

```bash
node scripts/test-skill-catalog.mjs
node scripts/test-opencode-config-builder.mjs
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/skill-manager.js resources/skills-catalog/lily-runtime-packs/SKILL.md resources/skills-catalog/lily-office-intent/SKILL.md resources/skills-catalog/lily-web-system-learning/SKILL.md scripts/test-skill-catalog.mjs
git commit -m "Treat first-party skills as chat-native capability contracts"
```

### Task 6: Add Chat-Native Guards To Capability Gate

**Files:**
- Modify: `CAPABILITY-GATE.md`
- Test: `scripts/test-capability-broker.mjs`
- Test: `scripts/test-chat-native-dependency-flow.mjs`
- Test: `scripts/test-process-job-observability.mjs`

- [x] **Step 1: Add guard rows**

Add rows for:

- UI-first operation regression
- dependency install blocks chat send
- unmanaged long task with no observable job/foreground tool
- capability broker missing fail-open text
- subagent missing capability/evidence handoff

- [x] **Step 2: Map each row to tests**

Use these guards:

- `test-capability-broker.mjs`
- `test-chat-native-dependency-flow.mjs`
- `test-process-job-observability.mjs`
- existing `test-skill-catalog.mjs`
- existing `test-opencode-config-builder.mjs`

- [ ] **Step 3: Run focused guard tests**

```bash
node scripts/test-capability-broker.mjs
node scripts/test-chat-native-dependency-flow.mjs
node scripts/test-process-job-observability.mjs
node scripts/test-skill-catalog.mjs
node scripts/test-opencode-config-builder.mjs
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add CAPABILITY-GATE.md scripts/test-capability-broker.mjs scripts/test-chat-native-dependency-flow.mjs scripts/test-process-job-observability.mjs
git commit -m "Guard chat-native capability routing"
```

### Task 7: End-To-End Verification

**Files:**
- Run existing focused tests.

- [ ] **Step 1: Run capability tests**

```bash
node scripts/test-capability-broker.mjs
node scripts/test-chat-native-dependency-flow.mjs
node scripts/test-process-job-observability.mjs
```

Expected: all pass.

- [ ] **Step 2: Run affected platform tests**

```bash
node scripts/test-skill-catalog.mjs
node scripts/test-opencode-config-builder.mjs
node scripts/test-runtime-boundary.mjs
node scripts/test-turn-artifacts.mjs
node scripts/test-filetree-security.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: all pass. Electron test may print missing test-only IPC handler warnings, but must end with `test-renderer-import: ok`.

- [ ] **Step 3: Run release smoke if the diff touches package/test registry**

```bash
npm run test:release
```

Expected: exits 0. If it prints a stored-license decrypt warning, treat it as non-blocking only if the process exits 0.

- [ ] **Step 4: Final manual checks**

Verify these behaviors in a dev run:

- User can ask for a missing dependency task and the message still sends.
- The answer can choose to install a pack or proceed with available tools.
- A long deterministic task appears as a running tool/job state in chat.
- A failed dependency/job/file operation returns a recoverable reason to the agent.
- Settings dependency pages remain available as health/advanced controls but are not required for normal task flow.

- [ ] **Step 5: Commit verification-only doc updates if any**

```bash
git add docs/superpowers/plans/2026-07-03-chat-native-capability-architecture.md memory/no-ui-natural-language.md
git commit -m "Document chat-native capability architecture"
```

## Self-Review

- Spec coverage: The plan covers chat-first operation, no UI-first workflows, dependency autonomy, process-job observability, skill contracts, subagent guidance, and capability-gate regression protection.
- Placeholder scan: This plan contains no unresolved placeholder markers.
- Type consistency: New APIs are limited to `listCapabilities()` and `compactCapabilityContext()` in `src/main/capability-broker.js`; later tasks use the same names.
- Scope boundary: The plan does not build a new UI. It only creates brokered capability context, non-blocking dependency routing, observable long jobs, and guard tests.
