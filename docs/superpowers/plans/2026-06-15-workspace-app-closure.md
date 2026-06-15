# Workspace App Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the first usable workspace app store loop: publish only valid Lily workspace app packs, then let the desktop client install them as workspaces.

**Architecture:** Reuse the existing `.lilyspace.zip` workspace pack format as the installable app artifact. The server validates the zip manifest before publishing; the client downloads, verifies sha256, imports with the existing hardened workspace importer, and opens the new workspace.

**Tech Stack:** Electron IPC, Fastify admin/public APIs, JSZip, existing workspace-share importer, renderer settings panel.

---

### Task 1: Server Manifest Gate

**Files:**
- Modify: `server/src/services/workspace-apps.js`
- Modify: `server/src/routes/admin/workspace-apps.js`
- Test: `scripts/test-workspace-apps.mjs`

- [ ] Add `inspectWorkspaceAppArtifact(buffer)` to parse `lily-workspace.json`.
- [ ] Require `kind` to be `lily-workspace-pack` or `lily-workspace-app`.
- [ ] Require current or older schema.
- [ ] Reject corrupt, plain, or future-schema zips.
- [ ] Preserve upload quality gate.

### Task 2: Client Install Path

**Files:**
- Modify: `src/main/ipc-projects.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/modules/workspace-apps.js`

- [ ] Add `apps:install` IPC handler.
- [ ] Download catalog `downloadUrl`.
- [ ] Verify `sha256`.
- [ ] Read app manifest using `workspace-share.readPackManifest`.
- [ ] Import as a new workspace under the default workspace parent.
- [ ] Create a default session and switch to the new workspace.

### Task 3: UI and Verification

**Files:**
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/modules/workspace-apps.js`
- Test: `scripts/test-workspace-apps.mjs`

- [ ] Replace “open download” with “install”.
- [ ] Show install success/failure toasts.
- [ ] Run targeted syntax checks.
- [ ] Run `node scripts/test-workspace-apps.mjs`.
