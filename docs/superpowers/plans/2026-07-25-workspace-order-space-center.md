# Workspace Ordering and Space Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace workspace pinning with durable manual ordering and add a keyboard-friendly Space Center for switching across workspaces and recent sessions.

**Architecture:** `ProjectManager.projects` remains the canonical ordered collection and gains a one-time pinned-to-manual migration plus a validated full-order IPC. Renderer behavior is split into `workspace-order.js` for sidebar organization and `workspace-switcher.js` for the centered quick switcher; both consume the existing renderer store and session-switch path.

**Tech Stack:** Electron main/preload IPC, native renderer DOM/ES modules, CSS custom properties, JSON i18n, Node `assert` tests, hidden Electron renderer integration tests.

**Design source:** `docs/superpowers/specs/2026-07-25-workspace-order-space-center-design.md`

---

## File Map

**Create**

- `scripts/test-project-manager-order.mjs`: migration, insertion, validation, persistence, and rollback tests.
- `scripts/test-workspace-order-model.mjs`: pure ordering and filter-lock tests.
- `scripts/test-workspace-switcher-model.mjs`: recent-session and grouped-search tests.
- `scripts/test-workspace-navigation.cjs`: hidden Electron interaction test for drag, keyboard, focus, search, and switching.
- `src/renderer/modules/workspace-order.js`: sidebar pointer/keyboard ordering, persistence rollback, auto-scroll, and undo.
- `src/renderer/modules/workspace-switcher.js`: Space Center rendering, focus, search, preview, and target activation.
- `src/renderer/styles/workspace-navigation.css`: search-row button, drag states, modal, grid, results, responsive/RTL styles.

**Modify**

- `src/main/project-manager.js`: canonical manual order, migration marker, insertion-at-top, reorder validation.
- `src/main/ipc-projects.js`: replace `project:pin` with `project:reorder`.
- `src/preload.js`: replace `pinProject` with `reorderProjects`.
- `src/renderer/modules/project-tree.js`: remove pin sorting/action; render handles and keyboard semantics; delegate reorder commands.
- `src/renderer/modules/toast.js`: add an explicit action-toast API without changing existing calls.
- `src/renderer/app.js`: initialize ordering/switcher and expose filtered-state semantics.
- `src/renderer/index.html`: add the Space Center button, overlay shell, and live region.
- `src/renderer/styles.css`: import the focused workspace-navigation stylesheet.
- `src/renderer/styles/layout.css`: convert the search area to a horizontal row and leave existing tree styles intact.
- `src/renderer/styles/overlays.css`: style action buttons inside existing toasts.
- `src/renderer/i18n/locales/{zh-CN,en,ar}.json`: replace pin text and add ordering/switcher strings.
- `scripts/test-renderer-import.cjs`: register new preload IPC mocks so the renderer smoke test remains complete.

---

### Task 1: Canonical Workspace Order and Legacy Migration

**Files:**

- Create: `scripts/test-project-manager-order.mjs`
- Modify: `src/main/project-manager.js`

- [ ] **Step 1: Write the failing ProjectManager test**

Create `scripts/test-project-manager-order.mjs` with a temporary
`LILY_USER_DATA_DIR`. The fixture must create valid workspace directories because
`ProjectManager.load()` repairs missing paths.

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-project-order-"));
process.env.LILY_USER_DATA_DIR = path.join(tmp, "user-data");
const { projectsConfigPath } = require("../src/main/config.js");
const ProjectManager = require("../src/main/project-manager.js");

function workspace(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readConfig() {
  return JSON.parse(fs.readFileSync(projectsConfigPath(), "utf8"));
}

try {
  const paths = {
    a: workspace("A"),
    b: workspace("B"),
    c: workspace("C"),
    d: workspace("D"),
  };
  fs.mkdirSync(path.dirname(projectsConfigPath()), { recursive: true });
  fs.writeFileSync(projectsConfigPath(), JSON.stringify({
    activeProjectId: "b",
    projects: [
      { id: "a", name: "A", path: paths.a, pinned: false },
      { id: "b", name: "B", path: paths.b, pinned: true },
      { id: "c", name: "C", path: paths.c, pinned: false },
      { id: "d", name: "D", path: paths.d, pinned: true },
    ],
  }, null, 2));

  const manager = new ProjectManager(workspace("Default"));
  manager.load();
  assert.deepEqual(manager.getAppState().projects.map((p) => p.id), ["b", "d", "a", "c"]);
  assert.equal(readConfig().workspaceOrderVersion, 1);
  assert.ok(readConfig().projects.every((p) => !Object.hasOwn(p, "pinned")));

  const afterFirstLoad = fs.readFileSync(projectsConfigPath(), "utf8");
  const reload = new ProjectManager(workspace("Default"));
  reload.load();
  assert.equal(fs.readFileSync(projectsConfigPath(), "utf8"), afterFirstLoad);

  assert.deepEqual(reload.reorder(["c", "b", "d", "a"]), { ok: true });
  assert.deepEqual(reload.getAppState().projects.map((p) => p.id), ["c", "b", "d", "a"]);
  assert.deepEqual(readConfig().projects.map((p) => p.id), ["c", "b", "d", "a"]);

  for (const ids of [
    ["c", "b", "d"],
    ["c", "b", "d", "d"],
    ["c", "b", "d", "missing"],
    ["c", "b", "d", "a", "extra"],
  ]) {
    assert.deepEqual(reload.reorder(ids), { ok: false, error: "INVALID_ORDER" });
    assert.deepEqual(reload.getAppState().projects.map((p) => p.id), ["c", "b", "d", "a"]);
  }

  const beforeFailure = reload.projects;
  const realSave = reload.save;
  reload.save = () => { throw new Error("disk full"); };
  assert.throws(() => reload.reorder(["a", "b", "c", "d"]), /disk full/);
  assert.equal(reload.projects, beforeFailure);
  reload.save = realSave;

  const newPath = workspace("Newest");
  const added = reload.add(newPath);
  assert.equal(reload.getAppState().projects[0].id, added.id);
  reload.add(paths.b);
  assert.equal(reload.getAppState().projects[0].id, added.id);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("project-manager-order: ok");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node scripts/test-project-manager-order.mjs
```

Expected: FAIL because `workspaceOrderVersion` and `ProjectManager.reorder()` do
not exist and current state still sorts on `pinned`.

- [ ] **Step 3: Implement migration and canonical ordering**

Add `workspaceOrderVersion` state in the constructor, load the legacy pin state
only for migration, and save the marker:

```js
constructor(defaultPath) {
  this.defaultPath = defaultPath;
  this.projects = [];
  this.activeProjectId = null;
  this.workspaceOrderVersion = 1;
}

_migrateWorkspaceOrder(rawVersion) {
  if (Number(rawVersion) >= 1) {
    for (const project of this.projects) delete project.pinned;
    this.workspaceOrderVersion = 1;
    return false;
  }
  const pinned = this.projects.filter((project) => project.pinned);
  const unpinned = this.projects.filter((project) => !project.pinned);
  this.projects = [...pinned, ...unpinned];
  for (const project of this.projects) delete project.pinned;
  this.workspaceOrderVersion = 1;
  return true;
}
```

In `load()`, retain `parsed.workspaceOrderVersion`, normalize projects, run
`_migrateWorkspaceOrder()` before path sanitization, and save once when migration
changed the configuration. In `save()`, serialize:

```js
{
  workspaceOrderVersion: this.workspaceOrderVersion,
  activeProjectId: this.activeProjectId,
  projects: this.projects,
}
```

Replace pinned sorting and insertion:

```js
getAppState() {
  return {
    activeProjectId: this.activeProjectId,
    projects: this.projects.map((project) => this._summary(project)),
  };
}

// Inside add(), only for a newly created project:
this.projects.unshift(project);
```

Remove `togglePin()`, stop normalizing/summarizing `pinned`, and add:

```js
reorder(projectIds) {
  if (!Array.isArray(projectIds) || projectIds.length !== this.projects.length) {
    return { ok: false, error: "INVALID_ORDER" };
  }
  const current = new Map(this.projects.map((project) => [project.id, project]));
  const unique = new Set(projectIds);
  if (unique.size !== this.projects.length || projectIds.some((id) => !current.has(id))) {
    return { ok: false, error: "INVALID_ORDER" };
  }
  const previous = this.projects;
  this.projects = projectIds.map((id) => current.get(id));
  try {
    this.save();
  } catch (error) {
    this.projects = previous;
    throw error;
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run migration/order tests**

Run:

```bash
node scripts/test-project-manager-order.mjs
node scripts/test-workspace-app-runtime.mjs
node scripts/test-data-migration.mjs
```

Expected: all three print their `ok` line and exit 0.

- [ ] **Step 5: Commit the persistence unit**

```bash
git add src/main/project-manager.js scripts/test-project-manager-order.mjs
git commit -m "feat: persist manual workspace ordering"
```

---

### Task 2: Replace Pin IPC With Validated Reorder IPC

**Files:**

- Create: `scripts/test-workspace-project-contract.mjs`
- Modify: `src/main/ipc-projects.js`
- Modify: `src/preload.js`

- [ ] **Step 1: Write the failing bridge contract test**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const ipc = fs.readFileSync("src/main/ipc-projects.js", "utf8");
const preload = fs.readFileSync("src/preload.js", "utf8");

assert.match(ipc, /ipcMain\.handle\("project:reorder"/);
assert.match(ipc, /projectManager\.reorder\(projectIds\)/);
assert.match(preload, /reorderProjects:\s*\(projectIds\)\s*=>\s*ipcRenderer\.invoke\("project:reorder", projectIds\)/);
assert.doesNotMatch(ipc, /project:pin|togglePin/);
assert.doesNotMatch(preload, /pinProject|project:pin/);

console.log("workspace-project-contract: ok");
```

- [ ] **Step 2: Run it and verify red**

Run: `node scripts/test-workspace-project-contract.mjs`

Expected: FAIL because the old pin IPC and preload method still exist.

- [ ] **Step 3: Replace the handler and bridge**

Use this handler in `registerProjectHandlers()`:

```js
ipcMain.handle("project:reorder", (_event, projectIds) => {
  const result = projectManager.reorder(projectIds);
  if (!result.ok) return result;
  return { ok: true, state: projectManager.getAppState() };
});
```

Use this preload bridge:

```js
reorderProjects: (projectIds) => ipcRenderer.invoke("project:reorder", projectIds),
```

Remove `project:pin` and `pinProject` completely.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node scripts/test-workspace-project-contract.mjs
node scripts/test-project-manager-order.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the IPC contract**

```bash
git add src/main/ipc-projects.js src/preload.js scripts/test-workspace-project-contract.mjs
git commit -m "feat: expose validated workspace reorder IPC"
```

---

### Task 3: Testable Ordering Model and Action Toast

**Files:**

- Create: `scripts/test-workspace-order-model.mjs`
- Create: `src/renderer/modules/workspace-order.js`
- Modify: `src/renderer/modules/toast.js`
- Modify: `src/renderer/styles/overlays.css`

- [ ] **Step 1: Write pure ordering tests**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  canReorderWorkspaces,
  moveWorkspaceIds,
  moveWorkspaceByDelta,
  orderProjectsByIds,
} from "../src/renderer/modules/workspace-order.js";

assert.deepEqual(moveWorkspaceIds(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
assert.deepEqual(moveWorkspaceIds(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
assert.deepEqual(moveWorkspaceIds(["a", "b", "c"], "missing", 1), ["a", "b", "c"]);
assert.deepEqual(moveWorkspaceByDelta(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
assert.deepEqual(moveWorkspaceByDelta(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
assert.equal(canReorderWorkspaces(""), true);
assert.equal(canReorderWorkspaces("  "), true);
assert.equal(canReorderWorkspaces("finance"), false);
assert.deepEqual(
  orderProjectsByIds([{ id: "a" }, { id: "b" }], ["b", "a"]).map((p) => p.id),
  ["b", "a"],
);

console.log("workspace-order-model: ok");
```

- [ ] **Step 2: Run it and verify red**

Run: `node scripts/test-workspace-order-model.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Create the model and controller skeleton**

Start `workspace-order.js` with these pure exports:

```js
export function canReorderWorkspaces(query) {
  return !String(query || "").trim();
}

export function moveWorkspaceIds(ids, sourceId, targetIndex) {
  const next = [...ids];
  const from = next.indexOf(sourceId);
  if (from < 0) return next;
  const [id] = next.splice(from, 1);
  const bounded = Math.max(0, Math.min(Number(targetIndex), next.length));
  next.splice(bounded, 0, id);
  return next;
}

export function moveWorkspaceByDelta(ids, sourceId, delta) {
  const from = ids.indexOf(sourceId);
  if (from < 0) return [...ids];
  const target = Math.max(0, Math.min(from + delta, ids.length - 1));
  if (target === from) return [...ids];
  return moveWorkspaceIds(ids, sourceId, target);
}

export function orderProjectsByIds(projects, ids) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const project of projects) {
    if (!ids.includes(project.id)) ordered.push(project);
  }
  return ordered;
}
```

Also export `initWorkspaceOrder(deps)` and
`reorderWorkspaceByCommand(projectId, command)` as initially empty controller
entry points; Task 4 fills their DOM behavior.

- [ ] **Step 4: Add a backward-compatible action toast**

Keep `showToast(message, type, duration)` unchanged. Add:

```js
export function showActionToast(message, actionLabel, onAction, type = "success", duration = 5000) {
  const el = showToast(message, type, duration);
  const action = document.createElement("button");
  action.type = "button";
  action.className = "toast-action";
  action.textContent = actionLabel;
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    remove(el);
    void onAction();
  });
  el.appendChild(action);
  return el;
}
```

Add `.toast-action` styling using existing color tokens, with a visible
focus state and no fixed width.

- [ ] **Step 5: Run the pure model and renderer import tests**

Run:

```bash
node scripts/test-workspace-order-model.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: both PASS. Existing toast callers behave unchanged.

- [ ] **Step 6: Commit the testable ordering base**

```bash
git add src/renderer/modules/workspace-order.js src/renderer/modules/toast.js src/renderer/styles/overlays.css scripts/test-workspace-order-model.mjs
git commit -m "feat: add workspace ordering model and undo toast"
```

---

### Task 4: Sidebar Pointer, Keyboard, and Context-Menu Ordering

**Files:**

- Modify: `src/renderer/modules/workspace-order.js`
- Modify: `src/renderer/modules/project-tree.js`
- Modify: `src/renderer/app.js`

- [ ] **Step 1: Extend the ordering test with persistence state transitions**

Add assertions around an exported `commitWorkspaceOrder()` using stubbed
dependencies:

```js
const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];
const paints = [];
const success = await commitWorkspaceOrder(["b", "a", "c"], {
  getProjects: () => projects,
  setProjects: (next) => paints.push(next.map((p) => p.id)),
  persist: async () => ({ ok: true, state: { projects: [{ id: "b" }, { id: "a" }, { id: "c" }] } }),
});
assert.equal(success.ok, true);
assert.deepEqual(paints, [["b", "a", "c"], ["b", "a", "c"]]);

const rollbackPaints = [];
const failure = await commitWorkspaceOrder(["c", "b", "a"], {
  getProjects: () => projects,
  setProjects: (next) => rollbackPaints.push(next.map((p) => p.id)),
  persist: async () => ({ ok: false, error: "SAVE_FAILED" }),
});
assert.equal(failure.ok, false);
assert.deepEqual(rollbackPaints, [["c", "b", "a"], ["a", "b", "c"]]);
```

- [ ] **Step 2: Run the test and verify the new assertions fail**

Run: `node scripts/test-workspace-order-model.mjs`

Expected: FAIL because `commitWorkspaceOrder` is not exported.

- [ ] **Step 3: Implement optimistic persistence and rollback**

```js
export async function commitWorkspaceOrder(nextIds, deps) {
  const previous = deps.getProjects();
  const optimistic = orderProjectsByIds(previous, nextIds);
  deps.setProjects(optimistic);
  try {
    const result = await deps.persist(nextIds);
    if (!result?.ok) {
      deps.setProjects(previous);
      return { ok: false, error: result?.error || "SAVE_FAILED" };
    }
    const canonicalIds = result.state?.projects?.map((project) => project.id) || nextIds;
    deps.setProjects(orderProjectsByIds(optimistic, canonicalIds));
    return { ok: true, previousIds: previous.map((project) => project.id) };
  } catch (error) {
    deps.setProjects(previous);
    return { ok: false, error: error?.message || "SAVE_FAILED" };
  }
}
```

The real dependency adapter must set the store and call `renderProjectTree()`
after each `setProjects`.

- [ ] **Step 4: Render order affordances and remove pin behavior**

In `renderProjectTree()`:

- Iterate `projects` directly; delete the pinned/unpinned stable partition.
- Make `.project-header` focusable and set
  `aria-label="${project.name}, ${position}/${total}"`.
- Append a real button `.workspace-drag-handle` before `.project-actions`.
- Give the handle a localized title and six CSS dots; do not use a text glyph.
- Ignore `.workspace-drag-handle` in the header expand/collapse click handler.
- Remove the pin/unpin context item.
- Add context actions that call:

```js
reorderWorkspaceByCommand(project.id, "top");
reorderWorkspaceByCommand(project.id, "up");
reorderWorkspaceByCommand(project.id, "down");
```

- [ ] **Step 5: Implement delegated pointer and keyboard behavior**

`initWorkspaceOrder()` binds once to `projectTree` and keeps this state:

```js
let candidate = null;
let active = null;
let holdTimer = null;
const HOLD_MS = 250;
const HOLD_SLOP_PX = 4;
const EDGE_PX = 28;
```

Required event sequence:

1. `pointerdown` on a handle starts immediately; a header starts `holdTimer`.
2. Movement over 4 px before the timer fires cancels the long-press candidate.
3. Active drag adds `workspace-ordering` to the tree and `is-dragging` to the
   source group, captures the pointer, and creates one insertion marker.
4. `pointermove` compares `clientY` with visible group midpoints, moves the
   marker, and auto-scrolls inside 28 px edge zones.
5. `pointerup` commits only when the insertion index changes.
6. `pointercancel`, window blur, and `Escape` restore classes and original DOM.
7. The click immediately following a completed drag is consumed so it cannot
   expand/collapse the workspace.
8. `Alt+ArrowUp/Down` on a workspace header uses the same persistence path.

On success, call:

```js
showActionToast(
  t("toast.workspaceOrderSaved"),
  t("common.undo"),
  () => commitAndRender(previousIds),
  "success",
  5000,
);
```

On failure show `toast.workspaceOrderFailed`.

- [ ] **Step 6: Make search state explicit**

In `initGlobalSearch()`, after normalizing the query:

```js
projectTree.dataset.filterActive = query ? "true" : "false";
projectTree.dispatchEvent(new CustomEvent("workspace-filter-change", {
  detail: { query },
}));
```

The ordering controller cancels an active candidate/drag and disables context
commands whenever `filterActive === "true"`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node scripts/test-workspace-order-model.mjs
node scripts/test-workspace-project-contract.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: PASS.

- [ ] **Step 8: Commit sidebar ordering**

```bash
git add src/renderer/modules/workspace-order.js src/renderer/modules/project-tree.js src/renderer/app.js scripts/test-workspace-order-model.mjs
git commit -m "feat: add accessible sidebar workspace reordering"
```

---

### Task 5: Space Center Search and Selection Model

**Files:**

- Create: `scripts/test-workspace-switcher-model.mjs`
- Create: `src/renderer/modules/workspace-switcher.js`

- [ ] **Step 1: Write the failing pure-model test**

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  latestSession,
  relativeTimeValue,
  recentSessions,
  searchWorkspaceTargets,
} from "../src/renderer/modules/workspace-switcher.js";

const projects = [
  {
    id: "finance",
    name: "Finance",
    path: "/work/finance",
    sessions: [
      { id: "old", title: "June report", updatedAt: "2026-07-01T10:00:00.000Z" },
      { id: "new", title: "July report", updatedAt: "2026-07-24T10:00:00.000Z" },
    ],
  },
  {
    id: "brand",
    name: "Brand",
    path: "/work/brand",
    sessions: [
      { id: "copy", title: "Homepage copy", updatedAt: "2026-07-23T10:00:00.000Z" },
    ],
  },
];

assert.equal(latestSession(projects[0]).id, "new");
assert.deepEqual(recentSessions(projects[0], 1).map((s) => s.id), ["new"]);
assert.deepEqual(searchWorkspaceTargets(projects, "finance").workspaces.map((p) => p.id), ["finance"]);
assert.deepEqual(searchWorkspaceTargets(projects, "report").sessions.map((r) => r.session.id), ["new", "old"]);
assert.deepEqual(searchWorkspaceTargets(projects, "homepage").sessions.map((r) => r.project.id), ["brand"]);
assert.deepEqual(searchWorkspaceTargets(projects, "missing"), { workspaces: [], sessions: [] });
assert.deepEqual(
  relativeTimeValue("2026-07-25T09:55:00.000Z", Date.parse("2026-07-25T10:00:00.000Z")),
  { value: -5, unit: "minute" },
);
assert.deepEqual(
  relativeTimeValue("2026-07-24T10:00:00.000Z", Date.parse("2026-07-25T10:00:00.000Z")),
  { value: -1, unit: "day" },
);

console.log("workspace-switcher-model: ok");
```

- [ ] **Step 2: Run it and verify red**

Run: `node scripts/test-workspace-switcher-model.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement pure model functions**

```js
function sessionTime(session) {
  const value = Date.parse(session?.updatedAt || session?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function recentSessions(project, limit = 3) {
  return [...(project?.sessions || [])]
    .sort((a, b) => sessionTime(b) - sessionTime(a))
    .slice(0, limit);
}

export function latestSession(project) {
  return recentSessions(project, 1)[0] || null;
}

export function relativeTimeValue(value, nowMs = Date.now()) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.round((timestamp - nowMs) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) return { value: 0, unit: "second" };
  if (absolute < 3600) return { value: Math.round(seconds / 60), unit: "minute" };
  if (absolute < 86400) return { value: Math.round(seconds / 3600), unit: "hour" };
  if (absolute < 2592000) return { value: Math.round(seconds / 86400), unit: "day" };
  if (absolute < 31536000) return { value: Math.round(seconds / 2592000), unit: "month" };
  return { value: Math.round(seconds / 31536000), unit: "year" };
}

export function searchWorkspaceTargets(projects, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return { workspaces: [], sessions: [] };
  const workspaces = [];
  const sessions = [];
  for (const project of projects || []) {
    const workspaceHaystack = `${project.name || ""} ${project.path || ""}`.toLocaleLowerCase();
    if (workspaceHaystack.includes(needle)) workspaces.push(project);
    for (const session of project.sessions || []) {
      if (String(session.title || "").toLocaleLowerCase().includes(needle)) {
        sessions.push({ project, session });
      }
    }
  }
  sessions.sort((a, b) => sessionTime(b.session) - sessionTime(a.session));
  return { workspaces, sessions };
}
```

Then add the DOM-controller export `initWorkspaceSwitcher()`; Task 6 fills it.

- [ ] **Step 4: Run the pure model test**

Run: `node scripts/test-workspace-switcher-model.mjs`

Expected: `workspace-switcher-model: ok`.

- [ ] **Step 5: Commit the switcher model**

```bash
git add src/renderer/modules/workspace-switcher.js scripts/test-workspace-switcher-model.mjs
git commit -m "feat: add workspace switcher search model"
```

---

### Task 6: Space Center DOM, Focus, and Switching

**Files:**

- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/modules/workspace-switcher.js`
- Modify: `scripts/test-renderer-import.cjs`

- [ ] **Step 1: Add static semantic shell**

Change `.left-top-actions` to contain a `.left-search-row`, keep
`#globalSearch`, and add:

```html
<button
  id="workspaceSwitcherBtn"
  class="workspace-switcher-btn"
  type="button"
  aria-haspopup="dialog"
  aria-expanded="false"
  data-i18n-title="workspaceCenter.open"
  data-i18n-aria-label="workspaceCenter.open"
>
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="3" y="3" width="4" height="4" rx="1"></rect>
    <rect x="10" y="3" width="4" height="4" rx="1"></rect>
    <rect x="17" y="3" width="4" height="4" rx="1"></rect>
    <rect x="3" y="10" width="4" height="4" rx="1"></rect>
    <rect x="10" y="10" width="4" height="4" rx="1"></rect>
    <rect x="17" y="10" width="4" height="4" rx="1"></rect>
    <rect x="3" y="17" width="4" height="4" rx="1"></rect>
    <rect x="10" y="17" width="4" height="4" rx="1"></rect>
    <rect x="17" y="17" width="4" height="4" rx="1"></rect>
  </svg>
</button>
```

Add after the main app shell:

```html
<section id="workspaceSwitcherOverlay" class="workspace-switcher-overlay" hidden>
  <div
    id="workspaceSwitcherDialog"
    class="workspace-switcher-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="workspaceSwitcherTitle"
  >
    <header class="workspace-switcher-header">
      <h2 id="workspaceSwitcherTitle" data-i18n="workspaceCenter.title">空间中心</h2>
      <input id="workspaceSwitcherSearch" type="search"
        data-i18n-placeholder="workspaceCenter.search"
        aria-controls="workspaceSwitcherContent" autocomplete="off" />
      <button id="workspaceSwitcherClose" type="button"
        data-i18n-aria-label="common.close">×</button>
    </header>
    <div id="workspaceSwitcherContent" class="workspace-switcher-content"></div>
  </div>
</section>
<div id="workspaceOrderLive" class="sr-only" aria-live="polite"></div>
```

- [ ] **Step 2: Initialize the module**

In `app.js`, import and call `initWorkspaceSwitcher()` after state hydration and
before the first `renderProjectTree()`. Call `initWorkspaceOrder()` at the same
point with the renderer dependencies.

- [ ] **Step 3: Implement open, close, focus trap, and shortcut**

`initWorkspaceSwitcher()` must:

- Open from the button or `Meta+K`/`Control+K`.
- Prevent the browser's default shortcut.
- Store the opener, set `aria-expanded`, unhide the overlay, render, and focus
  the search input.
- Select the active workspace and call `scrollIntoView({ block: "nearest" })`.
- Trap `Tab` between search, close, cards, and session rows.
- Close on `Escape` or backdrop click and restore opener focus.
- Ignore repeated activation while `switchPending` is true.

- [ ] **Step 4: Render grid, preview, search, and states**

Default rendering:

```js
const projects = store.get("projects") || [];
const selected = projects.find((project) => project.id === selectedProjectId) || projects[0] || null;
renderWorkspaceGrid(projects, selected);
renderRecentSessions(selected, recentSessions(selected, 3));
```

Behavior:

- Card hover/focus updates `selectedProjectId` and only rerenders the recent
  panel.
- Card click/Enter calls `activateWorkspace(project)`.
- Session click/Enter calls `activateSession(project, session)`.
- Non-empty search renders grouped workspace and session results from
  `searchWorkspaceTargets()`.
- Arrow keys update a single roving active target while focus stays in search.
- Empty projects render one button that invokes `addProjectBtn.click()`.
- Empty sessions render localized `暂无会话`.
- Card and session timestamps call `relativeTimeValue()` and format its result
  with `new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" })`; invalid
  timestamps render no time instead of `Invalid Date`.
- Truncated workspace/session names set `title` to the full visible-language
  name.
- Use existing `isSessionRunning()` and `getSessionAttention()` for status.
- Subscribe to runtime updates and patch only status elements; do not clear
  search or selection.

- [ ] **Step 5: Reuse the existing switching path**

```js
async function activateSession(project, session) {
  if (switchPending) return;
  switchPending = true;
  try {
    const result = await window.assistantClient.switchSession(session.id);
    if (!result?.ok) {
      showToast(result?.detail || t("toast.switchSessionFailed"), "error");
      return;
    }
    await applySessionSwitch(result, session.id, project.id);
    close();
  } catch (error) {
    showToast(error?.message || t("toast.switchSessionFailed"), "error");
  } finally {
    switchPending = false;
  }
}

async function activateWorkspace(project) {
  const session = latestSession(project);
  if (session) return activateSession(project, session);
  const result = await window.assistantClient.switchProject(project.id);
  if (!result?.ok) {
    showToast(result?.error || t("toast.switchWorkspaceFailed"), "error");
    return;
  }
  await refreshState();
  renderProjectTree();
  updateTopbarTitles();
  close();
}
```

If a target has disappeared, `refreshState()`, keep the overlay open, rerender,
and show `workspaceCenter.unavailable`.

- [ ] **Step 6: Update renderer smoke IPC mocks**

In `scripts/test-renderer-import.cjs`, register:

```js
ipcMain.handle("project:reorder", (_event, projectIds) => ({
  ok: true,
  state: { activeProjectId: "", projects: projectIds.map((id) => ({ id })) },
}));
```

Ensure its `state:full` fixture uses `projects`, not a parallel `workspaces`
shape, so the new switcher can render safely.

- [ ] **Step 7: Run renderer smoke and model tests**

Run:

```bash
node scripts/test-workspace-switcher-model.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: PASS with no unhandled renderer console errors.

- [ ] **Step 8: Commit Space Center behavior**

```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/modules/workspace-switcher.js scripts/test-renderer-import.cjs
git commit -m "feat: add Space Center quick switcher"
```

---

### Task 7: Styling, Localization, RTL, and Responsive Layout

**Files:**

- Create: `src/renderer/styles/workspace-navigation.css`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/styles/layout.css`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`

- [ ] **Step 1: Add all required localization keys**

Add these exact values to `zh-CN.json`:

```json
{
  "common.close": "关闭",
  "common.undo": "撤销",
  "sidebar.dragWorkspace": "拖动调整工作空间顺序",
  "ctx.moveTop": "移到顶部",
  "ctx.moveUp": "上移",
  "ctx.moveDown": "下移",
  "toast.workspaceOrderSaved": "已调整工作空间顺序",
  "toast.workspaceOrderFailed": "工作空间顺序保存失败，已恢复原顺序",
  "toast.switchWorkspaceFailed": "切换工作空间失败，请重试",
  "workspaceCenter.open": "空间中心",
  "workspaceCenter.title": "空间中心",
  "workspaceCenter.search": "搜索工作空间或会话…",
  "workspaceCenter.workspaces": "工作空间",
  "workspaceCenter.sessions": "会话",
  "workspaceCenter.recentSessions": "{name} · 最近会话",
  "workspaceCenter.noSessions": "暂无会话",
  "workspaceCenter.noResults": "没有匹配的工作空间或会话",
  "workspaceCenter.addWorkspace": "添加工作空间",
  "workspaceCenter.unavailable": "该项目已不可用，列表已刷新",
  "workspaceOrder.position": "{name}，第 {position} 项，共 {total} 项"
}
```

Add these exact values to `en.json`:

```json
{
  "common.close": "Close",
  "common.undo": "Undo",
  "sidebar.dragWorkspace": "Drag to reorder workspace",
  "ctx.moveTop": "Move to top",
  "ctx.moveUp": "Move up",
  "ctx.moveDown": "Move down",
  "toast.workspaceOrderSaved": "Workspace order updated",
  "toast.workspaceOrderFailed": "Could not save workspace order; the previous order was restored",
  "toast.switchWorkspaceFailed": "Could not switch workspace. Please retry.",
  "workspaceCenter.open": "Space Center",
  "workspaceCenter.title": "Space Center",
  "workspaceCenter.search": "Search workspaces or chats…",
  "workspaceCenter.workspaces": "Workspaces",
  "workspaceCenter.sessions": "Chats",
  "workspaceCenter.recentSessions": "{name} · Recent chats",
  "workspaceCenter.noSessions": "No chats yet",
  "workspaceCenter.noResults": "No matching workspace or chat",
  "workspaceCenter.addWorkspace": "Add workspace",
  "workspaceCenter.unavailable": "That item is no longer available. The list was refreshed.",
  "workspaceOrder.position": "{name}, item {position} of {total}"
}
```

Add these exact values to `ar.json`:

```json
{
  "common.close": "إغلاق",
  "common.undo": "تراجع",
  "sidebar.dragWorkspace": "اسحب لإعادة ترتيب مساحة العمل",
  "ctx.moveTop": "نقل إلى الأعلى",
  "ctx.moveUp": "نقل لأعلى",
  "ctx.moveDown": "نقل لأسفل",
  "toast.workspaceOrderSaved": "تم تحديث ترتيب مساحات العمل",
  "toast.workspaceOrderFailed": "تعذّر حفظ ترتيب مساحات العمل؛ تمت استعادة الترتيب السابق",
  "toast.switchWorkspaceFailed": "تعذّر التبديل إلى مساحة العمل. أعد المحاولة.",
  "workspaceCenter.open": "مركز مساحات العمل",
  "workspaceCenter.title": "مركز مساحات العمل",
  "workspaceCenter.search": "ابحث في مساحات العمل أو المحادثات…",
  "workspaceCenter.workspaces": "مساحات العمل",
  "workspaceCenter.sessions": "المحادثات",
  "workspaceCenter.recentSessions": "{name} · أحدث المحادثات",
  "workspaceCenter.noSessions": "لا توجد محادثات",
  "workspaceCenter.noResults": "لا توجد مساحة عمل أو محادثة مطابقة",
  "workspaceCenter.addWorkspace": "إضافة مساحة عمل",
  "workspaceCenter.unavailable": "لم يعد هذا العنصر متاحاً. تم تحديث القائمة.",
  "workspaceOrder.position": "{name}، العنصر {position} من {total}"
}
```

Delete `ctx.pin` and `ctx.unpin` from all three locale files.

- [ ] **Step 2: Implement the approved visual structure**

In `layout.css`, make `.left-top-actions` retain its existing padding/background
but add:

```css
.left-search-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 34px;
  gap: 7px;
}
```

In `workspace-navigation.css`:

- Keep cards at 6-8 px radius.
- Use existing surface, border, text, accent, shadow, duration, and z-index tokens.
- Keep the button exactly 34×34 so it cannot resize the row.
- Hide the drag handle until header hover or keyboard focus.
- Give the handle at least a 24×24 hit target.
- Collapse `.project-sessions` visually only under `.project-tree.workspace-ordering`.
- Style `.workspace-drop-marker` as a stable 2 px accent line.
- Size the dialog `width: min(720px, calc(100vw - 32px))` and constrain height.
- Use a 3-column grid by default, 2 columns below 620 px, and 1 below 430 px.
- Keep cards and recent rows single-level; do not nest decorative cards.
- Truncate names with `text-overflow: ellipsis`.
- Add `[dir="rtl"]` alignment/transform corrections.
- Rely on the existing global
  `@media (prefers-reduced-motion: reduce)` rule; add no required animation.

Import the file before `system.css`:

```css
@import "./styles/workspace-navigation.css";
```

- [ ] **Step 3: Run source and import checks**

Run:

```bash
node scripts/test-workspace-project-contract.mjs
node scripts/test-workspace-order-model.mjs
node scripts/test-workspace-switcher-model.mjs
npx electron scripts/test-renderer-import.cjs
```

Expected: PASS.

- [ ] **Step 4: Commit visual and localization work**

```bash
git add src/renderer/styles.css src/renderer/styles/layout.css src/renderer/styles/workspace-navigation.css src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json
git commit -m "feat: style and localize workspace navigation"
```

---

### Task 8: Electron Interaction Regression Test

**Files:**

- Create: `scripts/test-workspace-navigation.cjs`
- Modify: `fixtures/renderer/` only if the test cannot safely load the real renderer fixture.

- [ ] **Step 1: Create a hidden Electron interaction test**

Follow `scripts/test-scroll-autofollow.cjs`: launch a hidden `BrowserWindow`,
load the real renderer with deterministic IPC handlers, and expose three
workspaces with three sessions each.

The test must execute JavaScript in the renderer and assert:

```js
const result = await win.webContents.executeJavaScript(`(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tree = document.getElementById("projectTree");
  const search = document.getElementById("globalSearch");
  const centerButton = document.getElementById("workspaceSwitcherBtn");

  // Quick click expands/collapses and never calls reorder.
  const firstHeader = tree.querySelector('[data-project-id="a"] .project-header');
  firstHeader.click();
  const collapsedAfterClick = tree.querySelector('[data-project-id="a"] .project-sessions').style.display === "none";

  // Filter disables handles.
  search.value = "finance";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  const filterActive = tree.dataset.filterActive;
  const handleHiddenWhileFiltered = getComputedStyle(
    tree.querySelector(".workspace-drag-handle")
  ).pointerEvents === "none";

  // Shortcut opens and focuses search; Escape closes and restores focus.
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  await wait(30);
  const overlayOpen = !document.getElementById("workspaceSwitcherOverlay").hidden;
  const searchFocused = document.activeElement?.id === "workspaceSwitcherSearch";
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const focusRestored = document.activeElement === centerButton;

  return {
    collapsedAfterClick,
    filterActive,
    handleHiddenWhileFiltered,
    overlayOpen,
    searchFocused,
    focusRestored,
  };
})()`);

assert.equal(result.collapsedAfterClick, true);
assert.equal(result.filterActive, "true");
assert.equal(result.handleHiddenWhileFiltered, true);
assert.equal(result.overlayOpen, true);
assert.equal(result.searchFocused, true);
assert.equal(result.focusRestored, true);
```

Add deterministic pointer events for handle drag and a forced failing
`project:reorder` response. Assert successful drag sends all IDs once, failed
drag restores DOM order, `Alt+ArrowDown` sends the expected order, clicking a
workspace opens its newest session, and clicking a session result opens the
exact session.

- [ ] **Step 2: Run and verify any failures are behavioral**

Run:

```bash
npx electron scripts/test-workspace-navigation.cjs
```

Expected: `workspace-navigation: ok`. If PointerEvent construction differs by
Electron version, dispatch mouse-compatible pointer events in the fixture; do
not weaken the assertions.

- [ ] **Step 3: Run all focused tests together**

```bash
node scripts/test-project-manager-order.mjs
node scripts/test-workspace-project-contract.mjs
node scripts/test-workspace-order-model.mjs
node scripts/test-workspace-switcher-model.mjs
npx electron scripts/test-workspace-navigation.cjs
npx electron scripts/test-renderer-import.cjs
```

Expected: all exit 0.

- [ ] **Step 4: Commit the integration test**

```bash
git add scripts/test-workspace-navigation.cjs fixtures/renderer
git commit -m "test: cover workspace ordering and Space Center interactions"
```

---

### Task 9: Visual QA and Full Regression Gate

**Files:**

- Modify only files needed to fix issues found by verification.

- [ ] **Step 1: Run syntax and whitespace checks**

```bash
git diff --check
node scripts/test-project-manager-order.mjs
node scripts/test-workspace-project-contract.mjs
node scripts/test-workspace-order-model.mjs
node scripts/test-workspace-switcher-model.mjs
```

Expected: no output from `git diff --check`; all tests print `ok`.

- [ ] **Step 2: Run the renderer and full unit suite**

```bash
npx electron scripts/test-workspace-navigation.cjs
npx electron scripts/test-renderer-import.cjs
npm run test:unit
```

Expected: all pass. Record any pre-existing unrelated failure separately; do not
claim success if a new or relevant failure remains.

- [ ] **Step 3: Run the capability gate**

```bash
npm run test:capability-gate
```

Expected: PASS. This UI feature must not regress the agent's existing capability
routes or defaults.

- [ ] **Step 4: Start the app and perform visual QA**

Run:

```bash
npm run start:dev
```

Check at minimum:

- Dark/light themes and standard/large text.
- Left sidebar at 180 px and 450 px widths.
- 3, 9, and 12+ workspaces.
- Long Chinese, English, and Arabic names.
- Current workspace below the first nine items scrolls into view on open.
- Search switches from grid to grouped results without layout shift.
- Running/done/failed statuses update while the modal remains open.
- Drag auto-scroll, cancel, undo, save failure rollback, and filter lock.
- No overlap at narrow app widths; RTL reads and navigates correctly.

- [ ] **Step 5: Final diff review**

```bash
git status --short
git diff --stat
git diff -- src/main/project-manager.js src/main/ipc-projects.js src/preload.js
git diff -- src/renderer/modules/workspace-order.js src/renderer/modules/workspace-switcher.js
```

Expected: only feature/test/documentation files are changed; no generated
artifacts, archives, or pre-existing unrelated changes are staged.

- [ ] **Step 6: Commit verification fixes, if any**

```bash
git add src/main/project-manager.js src/main/ipc-projects.js src/preload.js
git add src/renderer/app.js src/renderer/index.html
git add src/renderer/modules/project-tree.js src/renderer/modules/toast.js
git add src/renderer/modules/workspace-order.js src/renderer/modules/workspace-switcher.js
git add src/renderer/styles.css src/renderer/styles/layout.css
git add src/renderer/styles/overlays.css src/renderer/styles/workspace-navigation.css
git add src/renderer/i18n/locales/zh-CN.json src/renderer/i18n/locales/en.json src/renderer/i18n/locales/ar.json
git add scripts/test-project-manager-order.mjs scripts/test-workspace-project-contract.mjs
git add scripts/test-workspace-order-model.mjs scripts/test-workspace-switcher-model.mjs
git add scripts/test-workspace-navigation.cjs scripts/test-renderer-import.cjs
git commit -m "fix: close workspace navigation verification gaps"
```

Skip this commit when verification required no changes.
