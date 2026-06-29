# Large Input Protocol Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable generic indexing and evidence query to the Lily File Intelligence MCP.

**Architecture:** Keep OpenCode as the runtime and keep Phase 2 inside the existing `lily_file_intelligence` MCP. Add a small local index store for text-like files and bounded directories. Query returns compact evidence with source path and line ranges; it does not generate answers and does not inject full files into model context.

**Tech Stack:** Node.js CommonJS in `src/main`, local filesystem storage, existing MCP SDK.

---

### Task 1: Generic Index Store

**Files:**
- Create: `src/main/mcp/file-intelligence-index.js`
- Test: `scripts/test-file-intelligence-index.mjs`

- [x] **Step 1: Write failing tests**

Cover text file indexing, bounded directory indexing, query evidence, and unsupported-file fail-open behavior.

- [x] **Step 2: Run test and verify RED**

Run: `node scripts/test-file-intelligence-index.mjs`

Expected: fails because `file-intelligence-index.js` does not exist.

- [x] **Step 3: Implement local index store**

Implement `indexPath`, `queryIndex`, and `readIndex` with explicit coverage metadata and source ranges.

- [x] **Step 4: Run test and verify GREEN**

Run: `node scripts/test-file-intelligence-index.mjs`

Expected: passes.

### Task 2: MCP Tools

**Files:**
- Modify: `src/main/mcp/file-intelligence-mcp.js`
- Test: `scripts/test-file-intelligence-mcp.mjs`

- [x] **Step 1: Add failing stdio assertions**

Extend the MCP smoke test to assert `index_path` and `query_index` are exposed and callable.

- [x] **Step 2: Run test and verify RED**

Run: `node scripts/test-file-intelligence-mcp.mjs`

Expected: fails because the new tools are absent.

- [x] **Step 3: Register MCP tools**

Expose `index_path` and `query_index`. The tools return JSON text and fail open.

- [x] **Step 4: Run test and verify GREEN**

Run: `node scripts/test-file-intelligence-mcp.mjs`

Expected: passes.

### Task 3: Regression Verification

- [x] **Step 1: Run focused tests**

Run:

```bash
node scripts/test-file-intelligence-core.mjs
node scripts/test-file-intelligence-index.mjs
node scripts/test-file-intelligence-mcp.mjs
node scripts/test-large-input-protocol.mjs
node scripts/test-mcp-config.mjs
node scripts/test-opencode-message-parts.mjs
```

- [x] **Step 2: Run integration-adjacent checks**

Run:

```bash
node scripts/test-opencode-config-builder.mjs
node scripts/test-document-send-flow.mjs
node scripts/test-document-query-index.mjs
```

- [x] **Step 3: Review diff**

Run `git diff --check` and leave changes unstaged unless the user asks to commit.
