# Large Input Protocol Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first production slice of the Large Input Protocol without hardcoding file-specific business workflows.

**Architecture:** Keep OpenCode as the runtime. Add a Lily File Intelligence stdio MCP server and wire it through the existing MCP config builder. Inject a concise inspect-first protocol into OpenCode guidance so the agent can choose the right tool instead of blindly reading large files.

**Tech Stack:** Node.js CommonJS in `src/main`, existing MCP SDK, existing OpenCode MCP config. Phase 1 stays lightweight and does not add per-format Python extraction; richer type-specific metadata inspectors are a follow-up under the same protocol.

---

### Task 1: Protocol Guidance

**Files:**
- Create: `src/main/large-input-protocol.js`
- Modify: `src/main/session-runner-pool.js`
- Test: `scripts/test-large-input-protocol.mjs`

- [x] **Step 1: Write failing tests**

Create `scripts/test-large-input-protocol.mjs` asserting:

```js
const { LARGE_INPUT_PROTOCOL_GUIDANCE, appendLargeInputProtocolGuidance } = require("../src/main/large-input-protocol.js");

assert(LARGE_INPUT_PROTOCOL_GUIDANCE.includes("inspect"), "guidance tells agent to inspect first");
assert(LARGE_INPUT_PROTOCOL_GUIDANCE.includes("do not read or attach the entire input blindly"), "guidance forbids blind ingestion");
assert(LARGE_INPUT_PROTOCOL_GUIDANCE.includes("fall back to normal tools"), "guidance requires fail-open fallback");

const once = appendLargeInputProtocolGuidance("BASE GUIDE");
const twice = appendLargeInputProtocolGuidance(once);
assert.equal((twice.match(/Large Input Protocol/g) || []).length, 1, "guidance is idempotent");
assert(once.startsWith("BASE GUIDE"), "existing guide remains first");
```

- [x] **Step 2: Run test and verify RED**

Run: `node scripts/test-large-input-protocol.mjs`

Expected: fails because `src/main/large-input-protocol.js` does not exist.

- [x] **Step 3: Implement protocol helper**

Create `src/main/large-input-protocol.js` with a constant guidance block and an idempotent append function.

- [x] **Step 4: Wire guidance into OpenCode**

In `SessionRunnerPool._opencodeGuideContent`, return `appendLargeInputProtocolGuidance(existingGuide)`.

- [x] **Step 5: Run test and verify GREEN**

Run: `node scripts/test-large-input-protocol.mjs`

Expected: passes.

### Task 2: File Intelligence MCP Entry

**Files:**
- Modify: `src/main/mcp-config.js`
- Test: `scripts/test-mcp-config.mjs`

- [x] **Step 1: Write failing test**

Extend `scripts/test-mcp-config.mjs` to assert `writeActiveMcpConfig` includes `lily_file_intelligence`, launched through Electron-as-Node with `src/main/mcp/file-intelligence-mcp-stdio.js`.

- [x] **Step 2: Run test and verify RED**

Run: `node scripts/test-mcp-config.mjs`

Expected: fails because the MCP entry is absent.

- [x] **Step 3: Add MCP config entry**

Add `buildFileIntelligenceMcpEntry()` to `src/main/mcp-config.js` and include it in `writeActiveMcpConfig` unless tool-broker-only mode is enabled.

- [x] **Step 4: Run test and verify GREEN**

Run: `node scripts/test-mcp-config.mjs`

Expected: passes.

### Task 3: Minimal File Intelligence MCP

**Files:**
- Create: `src/main/mcp/file-intelligence-core.js`
- Create: `src/main/mcp/file-intelligence-mcp.js`
- Create: `src/main/mcp/file-intelligence-mcp-stdio.js`
- Test: `scripts/test-file-intelligence-core.mjs`
- Test: `scripts/test-file-intelligence-mcp.mjs`

- [x] **Step 1: Write failing core tests**

Create tests covering:

- `inspectPath` reports compact metadata for large text files without returning contents.
- `samplePath` returns `coverage: "sampled"`.
- `extractPath` refuses large files without an explicit range.
- `extractPath` can extract an explicit line range.
- unsupported/binary files fail open with metadata rather than throwing.

- [x] **Step 2: Run test and verify RED**

Run: `node scripts/test-file-intelligence-core.mjs`

Expected: fails because the core module does not exist.

- [x] **Step 3: Implement core**

Implement deterministic local functions:

- `inspectPath({ path })`
- `samplePath({ path, strategy, maxBytes })`
- `extractPath({ path, range })`

Support directories, text-like files, CSV/logs, JSON, and Markdown. Return structured objects with `coverage`, `confidence`, and source metadata. Do not add a PDF-only path in Phase 1; record PDF/Office/image-specific metadata as follow-up work under the generic type-specific inspector interface.

- [x] **Step 4: Add stdio MCP wrapper**

Expose the three functions as MCP tools using `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport`.

- [x] **Step 5: Add and run stdio MCP smoke test**

Run:

```bash
node scripts/test-file-intelligence-mcp.mjs
```

Expected: passes and proves MCP clients can list and call `inspect_file`, `sample_file`, and `extract_file_range`.

- [x] **Step 6: Run tests and focused regression**

Run:

```bash
node scripts/test-file-intelligence-core.mjs
node scripts/test-file-intelligence-mcp.mjs
node scripts/test-mcp-config.mjs
node scripts/test-large-input-protocol.mjs
node scripts/test-opencode-message-parts.mjs
```

Expected: all pass.

### Task 4: Final Verification

**Files:**
- No additional source files.

- [x] **Step 1: Run relevant unit tests**

Run:

```bash
npm run test:unit -- --grep large-input
```

If the runner has no grep support or environment issues, run the focused Node tests from Task 3 and report the limitation.

Executed via the focused-test fallback because the new coverage is concentrated in standalone Node tests and OpenCode integration tests.

- [x] **Step 2: Review diff**

Run: `git diff --check` and `git diff --stat`.

- [x] **Step 3: Do not commit unless requested**

Leave implementation changes unstaged unless the user asks to commit.
