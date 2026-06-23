# OpenCode Source Of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Lily's chat/session read path toward OpenCode as the canonical message/session source, while keeping Lily-only metadata as an extension layer.

**Architecture:** OpenCode owns session messages, parts, status, archive, revert, and pagination. Lily owns project mapping, skill selection, permission mode, scheduled-task metadata, artifacts, file diffs, usage summaries, and UI enhancement metadata. The transition starts with an OpenCode conversation facade that reads official `session.messages` and falls back to Lily's legacy `messages.db` only when OpenCode data is unavailable.

**Tech Stack:** Electron main process, OpenCode official SDK `@opencode-ai/sdk/v2/client`, Node.js tests under `scripts/test-*.mjs`, existing Lily `SessionManager` / `TurnArchive` metadata.

---

### Task 1: Official Messages Adapter

**Files:**
- Create: `src/main/runtime/opencode-conversation-adapter.js`
- Modify: `src/main/runtime/opencode-sdk-session.js`
- Modify: `src/main/runtime/opencode-server-manager.js`
- Test: `scripts/test-opencode-conversation-adapter.mjs`
- Test: `scripts/test-opencode-sdk-session.mjs`
- Test: `scripts/test-opencode-server-manager.mjs`

- [x] Add `session.messages` to the SDK wrapper with `sessionID`, `limit`, and `before`.
- [x] Add `OpencodeServerManager.messages({ limit, before })`.
- [x] Convert OpenCode `{ info, parts }` records into Lily-compatible message envelopes.
- [x] Preserve OpenCode IDs as message IDs and expose `engineMessageId`.
- [x] Add focused tests for user text, assistant text, reasoning text, file parts, cursor pagination, and empty results.

### Task 2: Read Facade

**Files:**
- Create: `src/main/opencode-conversation-source.js`
- Modify: `src/main/ipc-sessions.js`
- Test: `scripts/test-opencode-conversation-source.mjs`

- [x] Add a facade that attempts OpenCode messages when a runner is alive and bound to an OpenCode session.
- [x] Merge Lily metadata from legacy `messages.db` by `engineMessageId` / `turnId` when available.
- [x] Fall back to `SessionManager.getConversationPage` if OpenCode is unavailable.
- [x] Update `session:get-conversation` to use the facade.

### Task 3: Metadata-Only Archive

**Files:**
- Modify: `src/main/turn-archive.js`
- Modify: `src/main/store/message-store.js`
- Test: `scripts/test-turn-archive.mjs`

- [x] Stop treating Lily's assistant transcript row as the canonical assistant message when `engineMessageId` is present.
- [x] Store Lily record metadata with `engineMessageId` so it can be merged into OpenCode messages.
- [x] Keep legacy full assistant text only as fallback; OpenCode messages are canonical when available.

### Task 4: Rewind And Delete Alignment

**Files:**
- Modify: `src/main/ipc-sessions.js`
- Modify: `src/main/session-manager.js`
- Test: `scripts/test-opencode-rewind-source.mjs`

- [x] Make rewind call official `session.revert` first.
- [x] Delete Lily metadata rows from the same turn/message range only after official revert succeeds.
- [x] Return refreshed OpenCode-backed conversation from the facade.

### Task 5: Legacy Cleanup Gate

**Files:**
- Modify: `src/main/session-manager.js`
- Modify: `src/main/store/message-store.js`
- Test: `scripts/test-session-store-split.mjs`

- [x] Keep legacy import for old installs.
- [x] Mark OpenCode-backed assistant rows as `canonicalSource=opencode` / `lilyStorageRole=metadata`.
- [x] Keep `messages.db` only as Lily metadata and legacy fallback for the OpenCode-backed read path.

### Verification

- [x] `node scripts/test-opencode-conversation-adapter.mjs`
- [x] `node scripts/test-opencode-conversation-source.mjs`
- [x] `node scripts/test-opencode-sdk-session.mjs`
- [x] `node scripts/test-opencode-server-manager.mjs`
- [x] `node scripts/test-opencode-agent-session.mjs`
- [x] `node scripts/test-turn-orchestrator.mjs`
- [x] `node scripts/test-session-manager.mjs`
- [x] `node scripts/test-session-store-split.mjs`
- [x] `git diff --check`
