# Universal Local Path Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept and locally analyze arbitrary files, directories, and archives without uploading unsafe or oversized content to the model.

**Architecture:** Preserve the current fast path for known small attachments, represent everything else by its live local path, and extend Lily file intelligence with bounded directory and archive operations. Archive contents are listed and selectively read in memory, never bulk-extracted into the workspace.

**Tech Stack:** Electron, Node.js CommonJS, MCP SDK, `7zip-bin`, existing Lily workspace index, Node assertion scripts.

---

### Task 1: Path attachment admission

**Files:**
- Modify: `scripts/test-file-staging-manager.mjs`
- Modify: `src/main/file-staging-manager.js`
- Modify: `scripts/test-clipboard-file-paste.mjs`
- Modify: `src/main/ipc-files.js`

- [ ] Add failing tests proving directories and unknown path-backed files are accepted as path-only attachments while unsupported pathless buffers still fail.
- [ ] Run `node scripts/test-file-staging-manager.mjs` and confirm `NOT_A_FILE` / `UNSUPPORTED_TYPE` failures.
- [ ] Implement filesystem-kind classification and preserve the existing known-small and known-large behavior.
- [ ] Add a failing clipboard test proving directory paths survive extraction.
- [ ] Update clipboard filtering and the picker to admit directory paths.
- [ ] Run both tests and confirm they pass.

### Task 2: Safe archive intelligence

**Files:**
- Create: `src/main/mcp/archive-intelligence.js`
- Create: `scripts/test-archive-intelligence.mjs`
- Modify: `src/main/mcp/file-intelligence-core.js`

- [ ] Create ZIP fixtures in the test with normal text, binary, nested, and unsafe-path entries.
- [ ] Add failing tests for archive classification, bounded listing, safe text reads, and unsafe/binary/oversized rejection.
- [ ] Run `node scripts/test-archive-intelligence.mjs` and confirm the module/behavior is absent.
- [ ] Implement packaged 7-Zip resolution, bounded manifest parsing, risk flags, and bounded single-entry reads.
- [ ] Expose archive classification and summaries from `inspectPath`.
- [ ] Re-run archive and core tests until green.

### Task 3: Directory and archive indexing

**Files:**
- Modify: `scripts/test-file-intelligence-core.mjs`
- Create: `scripts/test-workspace-index-source-bounds.mjs`
- Modify: `src/main/mcp/workspace-index-source.js`
- Modify: `src/main/mcp/file-intelligence-index.js`

- [ ] Add failing tests for entry/depth bounds, symlink-directory exclusion, and archive manifest indexing.
- [ ] Run the tests and confirm current traversal or archive indexing fails.
- [ ] Add bounded traversal accounting and archive metadata chunks without changing ordinary text/document chunk behavior.
- [ ] Run the focused index tests and existing index freshness tests.

### Task 4: Agent tools and message routing

**Files:**
- Modify: `scripts/test-opencode-message-parts.mjs`
- Modify: `src/main/runtime/opencode-message-parts.js`
- Modify: `src/main/mcp/file-intelligence-mcp.js`
- Modify: `src/renderer/modules/composer.js`

- [ ] Add failing tests proving directory/archive paths appear as readable local sources and never become raw file parts.
- [ ] Add MCP registrations for `list_archive` and `read_archive_entry`.
- [ ] Preserve path metadata through renderer dispatch.
- [ ] Update the attachment note to direct local inspection before user escalation.
- [ ] Run focused message/MCP contract tests.

### Task 5: User-facing semantics and release gate

**Files:**
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `src/renderer/index.html`
- Modify: `CAPABILITY-GATE.md`

- [ ] Update drag/drop copy to state that files, folders, and archives are accepted and large/unknown inputs stay local.
- [ ] Add the new regression guards to the capability registry.
- [ ] Run JSON parsing and localization contract tests.

### Task 6: Multi-pass verification

**Files:**
- No production files.

- [x] Run all focused tests for staging, clipboard, archives, directory bounds, indexing, MCP, and message parts.
- [x] Run `npm run test:unit`.
- [x] Review `git diff --check`, changed-file scope, and raw-upload safety.
- [x] Start the Electron development app and verify it reaches a usable window; report any environment-only blocker explicitly.
