# Workspace Automations and Drag Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users optionally share paused scheduled-task templates with a workspace and choose whether a Lily package dropped into chat is imported, attached, or ignored.

**Architecture:** Add deterministic task-template portability beside the scheduler, extend the workspace pack with a backward-compatible hidden automations entry, and centralize path-based package inspection/import in focused main-process modules. The renderer classifies dropped files through main-process IPC and opens a three-action decision dialog while preserving the existing attachment path as the fail-open fallback.

**Tech Stack:** Electron IPC, CommonJS main process, browser ES modules, JSZip, JSON manifests, existing Lily renderer primitives, Node test scripts.

---

## File Structure

- Create `src/main/scheduled-task-portability.js`: sanitize, validate, list, and restore portable task templates.
- Modify `src/main/scheduled-tasks.js`: expose a manager-owned paused-template import method.
- Modify `src/main/workspace-share.js`: write/read `.lilyspace/automations.json`.
- Create `src/main/workspace-package-inspector.js`: bounded, read-only path inspection and package metadata.
- Create `src/main/workspace-import-service.js`: common path-based workspace import and task restoration.
- Modify `src/main/ipc-projects.js`: register thin preview/export/inspect/import handlers and delegate.
- Modify `src/preload.js`: expose package inspection and path import.
- Create `src/renderer/modules/workspace-package-drop.js`: decision dialog and import/attach/cancel routing.
- Modify `src/renderer/modules/file-handler.js`: classify dropped files before staging.
- Modify `src/renderer/modules/project-tree.js`: use the same path import flow for the file picker.
- Modify renderer locale/CSS files: package decision and automation selection UI.
- Add focused tests under `scripts/` and capability-gate registration.

### Task 1: Portable Scheduled-Task Templates

**Files:**
- Create: `scripts/test-workspace-automation-sharing.mjs`
- Create: `src/main/scheduled-task-portability.js`
- Modify: `src/main/scheduled-tasks.js`
- Modify: `src/main/workspace-share.js`

- [ ] **Step 1: Write the failing task portability and pack round-trip test**

The test constructs enabled and paused tasks, exports selected IDs, imports the
pack, and asserts that only safe fields survive:

```js
const templates = portability.exportTaskTemplates(tasks, ["sched_daily"]);
assert.equal(templates.length, 1);
assert.deepEqual(Object.keys(templates[0]).sort(), [
  "permissionMode", "prompt", "schedule", "scheduleText", "title",
]);
assert.equal(imported.automationTemplates.length, 1);
assert.equal(imported.automationTemplates[0].schedule.type, "daily");
```

It also calls `manager.importPausedTemplates(templates, { projectId: "new-p", sessionId: "new-s" })`
and asserts new IDs, `enabled === false`, `status === "paused"`,
`nextRunAt === null`, and no copied run history.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node scripts/test-workspace-automation-sharing.mjs
```

Expected: failure because `scheduled-task-portability.js`,
`AUTOMATIONS_ENTRY`, and `importPausedTemplates` do not exist.

- [ ] **Step 3: Implement minimal portability and pack support**

`scheduled-task-portability.js` exports:

```js
function exportTaskTemplates(tasks, selectedTaskIds) {}
function normalizeTaskTemplates(value) {}
function importPausedTaskTemplates(manager, templates, scope) {}
function previewProjectTasks(manager, projectId) {}
```

Validation reuses `normalizeScheduleSpec`, caps text through `safeText`, allows
only known permission modes, and returns `{ templates, skipped }`.

`workspace-share.js` adds:

```js
const AUTOMATIONS_ENTRY = `${PACK_META_PREFIX}automations.json`;
```

`exportWorkspacePack` accepts `automationTemplates`, writes the hidden entry,
and records `automationCount`. `importWorkspacePack` returns
`automationTemplates` and `skippedAutomations`; absent entries produce empty
arrays.

- [ ] **Step 4: Run focused scheduler/share tests and verify GREEN**

Run:

```bash
node scripts/test-workspace-automation-sharing.mjs
node scripts/test-scheduled-tasks.mjs
node scripts/test-workspace-share.mjs
```

Expected: all pass.

### Task 2: Export and Import Selection Wiring

**Files:**
- Modify: `scripts/test-workspace-automation-sharing.mjs`
- Modify: `src/main/ipc-projects.js`
- Modify: `src/renderer/modules/project-tree.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `src/renderer/styles/overlays.css`

- [ ] **Step 1: Add failing IPC and renderer contract assertions**

Assert export preview returns project-scoped `scheduledTasks`, export accepts
`selectedScheduledTaskIds`, and the confirmation UI renders unchecked task
checkboxes. Assert imported templates are restored only when selected and all
remain paused.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
node scripts/test-workspace-automation-sharing.mjs
```

Expected: failure because export/import IPC does not expose task selection.

- [ ] **Step 3: Wire export selection and paused restoration**

The export handler obtains:

```js
const scheduledTasks = previewProjectTasks(ctx.scheduledTaskManager, project.id);
const selected = new Set(options.selectedScheduledTaskIds || []);
const automationTemplates = exportTaskTemplates(scheduledTasks, [...selected]);
```

The export modal adds one unchecked row per task. Import preview uses the same
row treatment; selected templates are passed to the import service and restored
against the newly created default session.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node scripts/test-workspace-automation-sharing.mjs
node scripts/test-workspace-share.mjs
node scripts/test-scheduled-task-bridge.mjs
node scripts/test-workspace-navigation.cjs
```

Expected: all pass under their required runtimes.

### Task 3: Bounded Package Inspection and Shared Path Import

**Files:**
- Create: `scripts/test-workspace-package-inspector.mjs`
- Create: `src/main/workspace-package-inspector.js`
- Create: `src/main/workspace-import-service.js`
- Modify: `src/main/ipc-projects.js`
- Modify: `src/preload.js`

- [ ] **Step 1: Write failing inspector/import-service tests**

Create valid app, valid workspace, plain ZIP, corrupt ZIP, oversized manifest,
future schema, and malformed automation fixtures. Assert:

```js
assert.equal((await inspectWorkspacePackage(appPath)).recognized, true);
assert.equal((await inspectWorkspacePackage(plainZip)).recognized, false);
assert.equal((await inspectWorkspacePackage(corruptZip)).recognized, false);
```

Also assert the path import service is used by both picker and direct-path IPC,
and never extracts during inspection.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node scripts/test-workspace-package-inspector.mjs
```

Expected: failure because the inspector and service do not exist.

- [ ] **Step 3: Implement bounded inspection**

The inspector:

- rejects non-files and non-ZIP candidates as unrecognized;
- caps local package bytes before loading;
- uses `readPackManifest`;
- caps manifest and automations entry sizes;
- returns declarative metadata only;
- maps corrupt/unsupported candidates to `{ ok: true, recognized: false }`;
- returns explicit errors only for a user-requested import.

The import service accepts `{ filePath, targetParent, selectedAutomationIndexes }`,
creates the project/default session, restores conventions/skills/tasks, and
returns the same state shape as today's IPC handler.

- [ ] **Step 4: Refactor IPC to delegate without growing the hotspot**

Register:

```js
ipcMain.handle("project:inspect-pack-path", (_event, filePath) => inspectWorkspacePackage(filePath));
ipcMain.handle("project:import-pack-path", (_event, payload) => importWorkspacePackagePath(ctx, payload));
```

The existing `project:import-pack` picker delegates to the same service.
`preload.js` exposes `inspectWorkspacePackage` and `importPackPath`.

- [ ] **Step 5: Run inspector, share, IPC, and architecture tests**

Run:

```bash
node scripts/test-workspace-package-inspector.mjs
node scripts/test-workspace-share.mjs
node scripts/test-workspace-automation-sharing.mjs
node scripts/test-architecture-boundaries.mjs
```

Expected: all pass and `ipc-projects.js` does not exceed its ratchet.

### Task 4: Chat Drop Decision Flow

**Files:**
- Create: `scripts/test-workspace-package-drop.mjs`
- Create: `src/renderer/modules/workspace-package-drop.js`
- Modify: `src/renderer/modules/file-handler.js`
- Modify: `src/renderer/modules/project-tree.js`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `src/renderer/styles/overlays.css`

- [ ] **Step 1: Write the failing drop-classification test**

Test exported pure functions with fake clients:

```js
const result = await classifyDroppedFiles(files, client);
assert.deepEqual(result.packages.map((item) => item.kind), ["lily-workspace-app"]);
assert.deepEqual(result.attachments.map((item) => item.name), ["notes.pdf"]);
```

Test decisions:

- import calls `importPackPath` and does not stage;
- attach calls the existing staging callback;
- cancel calls neither;
- inspection failure returns the file to attachments.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node scripts/test-workspace-package-drop.mjs
```

Expected: failure because `workspace-package-drop.js` does not exist.

- [ ] **Step 3: Implement the package decision controller**

The module exports deterministic classification plus a DOM dialog. It receives
callbacks for `stage`, `import`, and `onImported`, keeping state and session
switching outside the classifier. The dialog provides:

- Import application/workspace
- Send as file
- Cancel

For multiple packages it renders one row and decision per package and executes
imports sequentially.

- [ ] **Step 4: Integrate the global drop handler**

Replace direct `addBrowserFiles(dtFiles)` calls with:

```js
await handleDroppedFiles(dtFiles, {
  stageFiles: addBrowserFiles,
  onImported: refreshImportedWorkspace,
});
```

Ordinary files and all inspection failures still call `addBrowserFiles`.
The picker import in `project-tree.js` uses the same reviewed path-import
controller.

- [ ] **Step 5: Run renderer and attachment regression tests**

Run:

```bash
node scripts/test-workspace-package-drop.mjs
node scripts/test-file-staging-manager.mjs
node scripts/test-image-send-flow.mjs
npx electron scripts/test-renderer-import.cjs
node scripts/test-architecture-boundaries.mjs
```

Expected: all pass.

### Task 5: Capability Gate, Documentation, and Full Verification

**Files:**
- Modify: `src/shared/capability-gates.json`
- Modify: `CAPABILITY-GATE.md`
- Create: `memory/2026-07-26-workspace-package-portability.md`
- Modify: `memory/MEMORY.md`

- [ ] **Step 1: Register the capability guard**

Add a gate whose tests include:

```json
[
  "scripts/test-workspace-automation-sharing.mjs",
  "scripts/test-workspace-package-inspector.mjs",
  "scripts/test-workspace-package-drop.mjs",
  "scripts/test-workspace-share.mjs"
]
```

Document the invariants: automation export/import is opt-in, restored tasks are
paused, recognized packages require a user decision, and inspection failure
falls back to ordinary attachment behavior.

- [ ] **Step 2: Run focused gates**

Run:

```bash
node scripts/test-capability-gate-registry.mjs
node scripts/test-architecture-boundaries.mjs
npm run test:capability-gate
```

Expected: all pass.

- [ ] **Step 3: Run the complete suite**

Run:

```bash
npm run test:unit
```

Expected: every discovered test passes, including Electron renderer tests.

- [ ] **Step 4: Review and commit**

Run:

```bash
git diff --check
git status --short
```

Stage only files in this plan and commit:

```bash
git commit -m "feat: share automations and import dropped apps"
```
