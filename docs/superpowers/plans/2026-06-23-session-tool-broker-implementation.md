# Session Tool Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first production-ready slice of the session-scoped Lily tool broker so Lily extension tools are discovered through one broker and filtered by session capability.

**Architecture:** Add a pure registry/filter layer first, then connect it to an MCP stdio server. Keep OpenCode native tools untouched. The broker fails closed when session context cannot be resolved, and execution re-checks visibility before running a handler.

**Tech Stack:** Electron main process, Node.js CommonJS modules, `@modelcontextprotocol/sdk`, Zod schemas, existing `skill-manager`, `mcp-config`, `mail-mcp`, and `web-system-mcp` helpers.

---

### Task 1: Pure Broker Registry

**Files:**
- Create: `src/main/mcp/tool-broker-registry.js`
- Test: `scripts/test-tool-broker-registry.mjs`

- [x] Add a pure registry that returns allowed tool definitions from a session context.
- [x] Cover mail, runtime-pack, browser placeholder tools, and dynamic learned web-system tools.
- [x] Verify disabled skills produce no tools.

### Task 2: Broker Context

**Files:**
- Create: `src/main/mcp/tool-broker-context.js`
- Test: `scripts/test-tool-broker-context.mjs`

- [x] Add a context resolver that returns `sessionId`, `activeSkillIds`, permission mode, and workspace path.
- [x] Fail closed when session id is missing or unknown.
- [x] Add tests for explicit session id and missing session.

### Task 3: Broker MCP Server

**Files:**
- Create: `src/main/mcp/tool-broker-mcp.js`
- Create: `src/main/mcp/tool-broker-stdio.js`
- Test: `scripts/test-tool-broker-mcp.mjs`

- [x] Build an MCP server from the broker registry.
- [x] Register only allowed real tool names for the resolved session.
- [x] Re-check visibility before handler execution.
- [x] Return structured text JSON for all tool results.

### Task 4: Shared Config Integration

**Files:**
- Modify: `src/main/mcp-config.js`
- Modify: `src/main/session-runner-pool.js`
- Test: `scripts/test-mcp-config.mjs`
- Test: `scripts/test-session-runner-pool-skill-scope.mjs`

- [x] Add a broker MCP entry builder.
- [x] Gate the broker behind `LILY_TOOL_BROKER=1`.
- [x] Keep the current direct MCP path as migration fallback when the flag is off.
- [x] Verify broker mode emits only `lily_tool_broker` for Lily extension tools.

### Task 5: Verification

**Files:**
- Modify tests only if needed.

- [x] Run broker-focused tests.
- [x] Run OpenCode runtime tests.
- [x] Run full `npm run test:unit`.
