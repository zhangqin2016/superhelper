# Browser Runtime Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser QA resolve and use the installed `web-automation` pack consistently across preflight, environment setup, MCP configuration, and tool exposure.

**Architecture:** Add one effective-pack lookup API in `runtime-packs.js` and inject it into MCP construction. Gate browser tools by runtime availability and focused skill context while keeping explicit, recoverable unavailable errors.

**Tech Stack:** Electron main-process CommonJS, Playwright MCP, runtime-pack JSON state, Node.js tests.

---

## File map

- Modify `src/main/runtime-packs.js`: public effective pack lookup.
- Modify `src/main/runtime-pack-preflight.js`: map browser-facing skills to `web-automation`.
- Modify `src/main/mcp-config.js`: accept installed-pack directory before bundle fallback.
- Modify `src/main/session-runner-pool.js`: pass effective pack context to MCP configuration.
- Modify `src/main/mcp/tool-broker-registry.js`: expose browser tools only with skill/runtime context and retain structured unavailable status.
- Modify `scripts/test-runtime-pack-preflight.mjs`, `scripts/test-mcp-config.mjs`, and `scripts/test-tool-broker-registry.mjs`: path and gating regressions.

### Task 1: Require the Web Automation pack for browser QA

- [ ] **Step 1: Add failing assertions to `scripts/test-runtime-pack-preflight.mjs`**

```js
for (const skillIds of [
  ["lily-browser-qa"],
  ["lily-ui-quality", "lily-browser-qa"],
  ["lily-app-builder", "lily-browser-qa"],
]) {
  const result = buildRuntimePackPreflight({ skillIds, installedPackIds: [] });
  includes(result.requiredPackIds, "web-automation", `${skillIds.join(",")} requires browser automation`);
  includes(result.missingPackIds, "web-automation", "missing pack is reported");
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `node scripts/test-runtime-pack-preflight.mjs`

Expected: FAIL for `lily-browser-qa` because it currently maps only web-system learning.

- [ ] **Step 3: Extend `SKILL_PACK_REQUIREMENTS`**

```js
const SKILL_PACK_REQUIREMENTS = Object.freeze({
  "anthropics-pdf": ["libreoffice", "large-document"],
  "anthropics-docx": ["libreoffice"],
  "lily-web-system-learning": ["web-automation"],
  "lily-browser-qa": ["web-automation"],
});
```

Retain every existing mapping from the current object; the two non-Web lines above illustrate that this is an additive edit, not a replacement. Do not require the pack for `lily-ui-quality` or `lily-app-builder` alone; only an actual browser-QA step makes it mandatory.

- [ ] **Step 4: Run and commit**

Run: `node scripts/test-runtime-pack-preflight.mjs`

Expected: PASS.

```bash
git add src/main/runtime-pack-preflight.js scripts/test-runtime-pack-preflight.mjs
git commit -m "fix: preflight browser QA runtime pack"
```

### Task 2: Add a single effective pack-directory API

- [ ] **Step 1: Add failing coverage in a new `scripts/test-runtime-pack-resolution.mjs`**

Create temporary selected, fallback, and bundled roots. Assert selected user installs win, fallback installs come second, bundled packs come last, and missing packs return an empty string.

```js
assert.equal(runtimePacks.getEffectiveRuntimePackDir("web-automation"), selectedWebPack);
assert.equal(runtimePacks.getEffectiveRuntimePackDir("missing-pack"), "");
```

- [ ] **Step 2: Run and confirm the export is missing**

Run: `node scripts/test-runtime-pack-resolution.mjs`

Expected: FAIL because `getEffectiveRuntimePackDir` is not exported.

- [ ] **Step 3: Implement and export the lookup in `src/main/runtime-packs.js`**

```js
function getEffectiveRuntimePackDir(id) {
  if (!id) return "";
  const entry = effectivePackEntries().find((item) => item.id === id && item.source !== "pip");
  return entry?.dir && fs.existsSync(entry.dir) ? entry.dir : "";
}
```

Also export `effectivePackEntries` only if an existing caller needs metadata; otherwise keep it private.

- [ ] **Step 4: Run and commit**

Run: `node scripts/test-runtime-pack-resolution.mjs`

Expected: PASS.

```bash
git add src/main/runtime-packs.js scripts/test-runtime-pack-resolution.mjs
git commit -m "feat: resolve effective runtime pack directories"
```

### Task 3: Build Playwright MCP from the pack layout

- [ ] **Step 1: Extend `scripts/test-mcp-config.mjs` with a real pack layout**

```js
const pack = path.join(tmp, "web-automation");
fs.mkdirSync(path.join(pack, "node_modules", "@playwright", "mcp"), { recursive: true });
fs.mkdirSync(path.join(pack, "browsers"), { recursive: true });
fs.writeFileSync(path.join(pack, "node_modules", "@playwright", "mcp", "cli.js"), "");
const packCfg = buildMcpConfig({ runtimeDir: empty, webAutomationPackDir: pack });
assert.equal(packCfg.mcpServers.playwright.args[0], path.join(pack, "node_modules", "@playwright", "mcp", "cli.js"));
assert.equal(packCfg.mcpServers.playwright.env.PLAYWRIGHT_BROWSERS_PATH, path.join(pack, "browsers"));
```

- [ ] **Step 2: Run and confirm failure**

Run: `node scripts/test-mcp-config.mjs`

Expected: FAIL because MCP construction only checks `<runtimeDir>/web`.

- [ ] **Step 3: Generalize Playwright layout resolution in `src/main/mcp-config.js`**

Add a resolver returning `{ nodeCommand, cliPath, browsersPath }`. For a pack, use the bundled runtime Node executable as the command and the pack's `node_modules/@playwright/mcp/cli.js`; for the legacy base runtime, retain the current paths.

```js
function resolvePlaywrightRuntime({ runtimeDir, webAutomationPackDir = "" } = {}) {
  const command = nodeBinaryPath(runtimeDir);
  const packCli = path.join(webAutomationPackDir, "node_modules", "@playwright", "mcp", "cli.js");
  if (command && webAutomationPackDir && fs.existsSync(packCli)) {
    return { command, cliPath: packCli, browsersPath: path.join(webAutomationPackDir, "browsers") };
  }
  return resolveBundledPlaywrightRuntime(runtimeDir);
}
```

Make `buildMcpConfig` and `writeMcpConfig` accept `webAutomationPackDir` without breaking existing callers.

- [ ] **Step 4: Pass the effective directory from `session-runner-pool.js`**

```js
const webAutomationPackDir = require("./runtime-packs").getEffectiveRuntimePackDir("web-automation");
const mcpConfig = buildMcpConfig({ runtimeDir: bundleRuntimeDir(), webAutomationPackDir, ...existingOptions });
```

- [ ] **Step 5: Run and commit**

Run: `node scripts/test-mcp-config.mjs && node scripts/test-runtime-pack-resolution.mjs`

Expected: PASS for pack, bundled-runtime, and unavailable layouts.

```bash
git add src/main/mcp-config.js src/main/session-runner-pool.js scripts/test-mcp-config.mjs
git commit -m "feat: wire web automation pack into Playwright MCP"
```

### Task 4: Make browser tool exposure reflect runtime state

- [ ] **Step 1: Add focused tool-broker tests**

In `scripts/test-tool-broker-registry.mjs`, assert:

```js
const available = listTools({ activeSkillIds: ["lily-browser-qa"], runtime: { browserAvailable: true } });
assert.ok(names(available).includes("browser_open"));

const missing = listTools({ activeSkillIds: ["lily-browser-qa"], runtime: { browserAvailable: false } });
assert.equal(names(missing).includes("browser_open"), false);
assert.ok(missing.status.unavailableTools.some((tool) => tool.reason === "BROWSER_RUNTIME_UNAVAILABLE"));

const unrelated = listTools({ activeSkillIds: ["lily-document-query"], runtime: { browserAvailable: true } });
assert.equal(names(unrelated).includes("browser_open"), false);
```

- [ ] **Step 2: Replace the permanent unavailable handler with an injected browser handler**

Resolve `browserOpen` from dependencies. Register the tool definition only when browser focus and runtime availability are both true; otherwise record `BROWSER_RUNTIME_UNAVAILABLE` for focused browser requests. The handler must throw the same structured reason if runtime state changes between listing and invocation.

- [ ] **Step 3: Preserve focused skill context in shared runner configuration**

Pass current turn skill IDs into the tool broker request context rather than storing them as a static platform-only OpenCode configuration. Keep shared MCP process configuration independent of one conversation.

- [ ] **Step 4: Run broker suites and commit**

Run: `node scripts/test-tool-broker-registry.mjs && node scripts/test-tool-broker-mcp.mjs && node scripts/test-mcp-config.mjs`

Expected: PASS; browser tool is visible only for focused, available sessions.

```bash
git add src/main/mcp/tool-broker-registry.js src/main/session-runner-pool.js scripts/test-tool-broker-registry.mjs scripts/test-tool-broker-mcp.mjs
git commit -m "fix: gate browser tools by focused runtime context"
```

### Task 5: Verify recovery paths

- [ ] **Step 1: Run focused runtime suites**

Run: `node scripts/test-runtime-pack-preflight.mjs && node scripts/test-runtime-pack-resolution.mjs && node scripts/test-mcp-config.mjs && node scripts/test-tool-broker-registry.mjs`

Expected: all PASS.

- [ ] **Step 2: Run runtime health coverage**

Run: `node scripts/test-runtime-health.mjs`

Expected: PASS or an explicit bundled-runtime skip already supported by the test; no false browser-ready state.

- [ ] **Step 3: Fully restart the development app and inspect MCP startup**

Run: `npm start`

Expected: with `web-automation` installed, Playwright MCP starts from that pack; without it, chat remains usable and browser QA reports the recoverable installation requirement.
