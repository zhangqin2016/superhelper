#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canReorderWorkspaces,
  commitWorkspaceOrder,
  initWorkspaceOrder,
  moveWorkspaceByDelta,
  moveWorkspaceIds,
  orderProjectsByIds,
  reorderKnownProjectSlots,
  reorderWorkspaceByCommand,
} from "../src/renderer/modules/workspace-order.js";
import * as workspaceOrderModel from "../src/renderer/modules/workspace-order-model.js";

for (const [name, legacyExport] of Object.entries({
  canReorderWorkspaces,
  commitWorkspaceOrder,
  moveWorkspaceByDelta,
  moveWorkspaceIds,
  orderProjectsByIds,
  reorderKnownProjectSlots,
})) {
  assert.equal(
    legacyExport,
    workspaceOrderModel[name],
    `${name} should keep the legacy workspace-order.js import contract`,
  );
}

assert.equal(canReorderWorkspaces(""), true);
assert.equal(canReorderWorkspaces("  "), true);
assert.equal(canReorderWorkspaces(null), true);
assert.equal(canReorderWorkspaces("finance"), false);

const originalIds = ["a", "b", "c"];
assert.deepEqual(moveWorkspaceIds(originalIds, "a", 2), ["b", "c", "a"]);
assert.deepEqual(moveWorkspaceIds(originalIds, "c", 0), ["c", "a", "b"]);
assert.deepEqual(moveWorkspaceIds(originalIds, "missing", 1), originalIds);
assert.deepEqual(moveWorkspaceIds(originalIds, "b", -100), ["b", "a", "c"]);
assert.deepEqual(moveWorkspaceIds(originalIds, "b", 100), ["a", "c", "b"]);
assert.deepEqual(moveWorkspaceIds(originalIds, "b", Number.NaN), originalIds);
assert.deepEqual(moveWorkspaceIds(originalIds, "b", Number.POSITIVE_INFINITY), originalIds);
assert.deepEqual(moveWorkspaceIds(originalIds, "b", "1"), originalIds);
assert.deepEqual(moveWorkspaceIds(originalIds, "b", 1.9), originalIds);
assert.deepEqual(originalIds, ["a", "b", "c"]);
assert.notEqual(moveWorkspaceIds(originalIds, "missing", 1), originalIds);

assert.deepEqual(moveWorkspaceByDelta(originalIds, "b", -1), ["b", "a", "c"]);
assert.deepEqual(moveWorkspaceByDelta(originalIds, "a", -1), originalIds);
assert.deepEqual(moveWorkspaceByDelta(originalIds, "c", 50), originalIds);
assert.deepEqual(moveWorkspaceByDelta(originalIds, "b", Number.NaN), originalIds);
assert.deepEqual(moveWorkspaceByDelta(originalIds, "b", Number.NEGATIVE_INFINITY), originalIds);
assert.deepEqual(moveWorkspaceByDelta(originalIds, "b", "1"), originalIds);
assert.deepEqual(moveWorkspaceByDelta(originalIds, "b", 0.5), originalIds);
assert.deepEqual(originalIds, ["a", "b", "c"]);
assert.notEqual(moveWorkspaceByDelta(originalIds, "missing", 1), originalIds);

const projects = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];
const reorderedProjects = orderProjectsByIds(projects, ["c", "unknown", "c", "a"]);
assert.deepEqual(reorderedProjects.map((project) => project.id), ["c", "a", "b"]);
assert.deepEqual(projects.map((project) => project.id), ["a", "b", "c"]);
assert.notEqual(reorderedProjects, projects);
assert.equal(new Set(reorderedProjects).size, projects.length);
assert.deepEqual(orderProjectsByIds(projects, []), projects);
assert.throws(
  () => orderProjectsByIds([{ id: "duplicate" }, { id: "duplicate" }], ["duplicate"]),
  (error) => error?.code === "DUPLICATE_PROJECT_ID" && error.message.includes("duplicate"),
);
const slottedProjects = [
  { id: "d", status: "new" },
  { id: "c" },
  { id: "b" },
  { id: "a" },
];
assert.deepEqual(
  reorderKnownProjectSlots(slottedProjects, ["a", "b", "c"]).map((project) => project.id),
  ["d", "a", "b", "c"],
  "projects outside the known id set should keep their absolute slots",
);
assert.deepEqual(
  reorderKnownProjectSlots(slottedProjects, ["b", "c", "a"]).map((project) => project.id),
  ["d", "b", "c", "a"],
);
assert.deepEqual(slottedProjects.map((project) => project.id), ["d", "c", "b", "a"]);
assert.throws(
  () => reorderKnownProjectSlots([{ id: "duplicate" }, { id: "duplicate" }], ["duplicate"]),
  (error) => error?.code === "DUPLICATE_PROJECT_ID",
);

const commitProjects = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];
const requestedIds = ["b", "a", "c"];
const successPaints = [];
let successProjects = commitProjects;
let resolvePersist;
const successDeps = {
  getProjects: () => successProjects,
  setProjects: (next) => {
    successProjects = next;
    successPaints.push(next.map((project) => project.id));
  },
  persist: () => new Promise((resolve) => {
    resolvePersist = resolve;
  }),
};
const successCommit = commitWorkspaceOrder(requestedIds, successDeps);
assert.deepEqual(successPaints, [["b", "a", "c"]], "commit should paint the optimistic order immediately");
assert.deepEqual(requestedIds, ["b", "a", "c"], "commit should not mutate the requested id array");
successProjects = successProjects.map((project) => (
  project.id === "b" ? { ...project, title: "Beta refreshed", status: "running" } : project
));
successProjects.unshift({ id: "d", name: "Delta", status: "new" });
resolvePersist({
  ok: true,
  state: { projects: [{ id: "b" }, { id: "c" }, { id: "a" }] },
});
assert.deepEqual(await successCommit, {
  ok: true,
  previousIds: ["a", "b", "c"],
});
assert.deepEqual(
  successPaints,
  [["b", "a", "c"], ["d", "b", "c", "a"]],
  "commit should repaint using the canonical main-process order",
);
assert.deepEqual(
  successProjects.find((project) => project.id === "b"),
  { id: "b", name: "Beta", title: "Beta refreshed", status: "running" },
  "successful canonical repaint should preserve fields updated while persistence was pending",
);
assert.equal(successProjects[0].id, "d", "a concurrently added project should remain in its top slot");

const failedPaints = [];
let failedProjects = commitProjects;
let resolveFailedPersist;
const failedResultPromise = commitWorkspaceOrder(["c", "b", "a"], {
  getProjects: () => failedProjects,
  setProjects: (next) => {
    failedProjects = next;
    failedPaints.push(next.map((project) => project.id));
  },
  persist: () => new Promise((resolve) => {
    resolveFailedPersist = resolve;
  }),
});
failedProjects = failedProjects.map((project) => (
  project.id === "a" ? { ...project, sessionCount: 8, status: "idle" } : project
));
failedProjects.unshift({ id: "d", name: "Delta", status: "new" });
resolveFailedPersist({ ok: false, error: "SAVE_FAILED" });
const failedResult = await failedResultPromise;
assert.deepEqual(failedResult, { ok: false, error: "SAVE_FAILED" });
assert.deepEqual(failedPaints, [["c", "b", "a"], ["d", "a", "b", "c"]]);
assert.deepEqual(
  failedProjects.find((project) => project.id === "a"),
  { id: "a", name: "Alpha", sessionCount: 8, status: "idle" },
  "rollback should preserve fields updated while persistence was pending",
);

const thrownPaints = [];
let thrownProjects = commitProjects;
let rejectThrownPersist;
const thrownResultPromise = commitWorkspaceOrder(["c", "a", "b"], {
  getProjects: () => thrownProjects,
  setProjects: (next) => {
    thrownProjects = next;
    thrownPaints.push(next.map((project) => project.id));
  },
  persist: () => new Promise((_resolve, reject) => {
    rejectThrownPersist = reject;
  }),
});
thrownProjects = thrownProjects.map((project) => (
  project.id === "c" ? { ...project, attention: "done" } : project
));
rejectThrownPersist(new Error("disk offline"));
const thrownResult = await thrownResultPromise;
assert.deepEqual(thrownResult, { ok: false, error: "disk offline" });
assert.deepEqual(thrownPaints, [["c", "a", "b"], ["a", "b", "c"]]);
assert.equal(thrownProjects.find((project) => project.id === "c").attention, "done");

let resolveLockedPersist;
let lockedPersistCalls = 0;
const lockedPaints = [];
const lockedDeps = {
  getProjects: () => commitProjects,
  setProjects: (next) => lockedPaints.push(next.map((project) => project.id)),
  persist: async () => {
    lockedPersistCalls += 1;
    return new Promise((resolve) => {
      resolveLockedPersist = resolve;
    });
  },
};
const lockedCommit = commitWorkspaceOrder(["b", "a", "c"], lockedDeps);
assert.deepEqual(
  await commitWorkspaceOrder(["c", "b", "a"], lockedDeps),
  { ok: false, error: "WORKSPACE_ORDER_BUSY" },
);
assert.equal(lockedPersistCalls, 1);
assert.deepEqual(lockedPaints, [["b", "a", "c"]]);
resolveLockedPersist({ ok: true, state: { projects: commitProjects } });
await lockedCommit;

assert.deepEqual(await reorderWorkspaceByCommand("a", "up"), {
  ok: false,
  error: "WORKSPACE_ORDER_NOT_INITIALIZED",
});

let commandProjects = [...commitProjects];
const commandPersists = [];
const sharedDeps = {
  getProjects: () => commandProjects,
  setProjects: (next) => {
    commandProjects = next;
  },
  persist: async (ids) => {
    commandPersists.push([...ids]);
    return { ok: true, state: { projects: ids.map((id) => ({ id })) } };
  },
  isFilterActive: () => false,
};
const firstController = initWorkspaceOrder(sharedDeps);
const secondController = initWorkspaceOrder(sharedDeps);
firstController.dispose();
assert.deepEqual(await reorderWorkspaceByCommand("c", "top"), {
  ok: true,
  previousIds: ["a", "b", "c"],
});
assert.deepEqual(commandProjects.map((project) => project.id), ["c", "a", "b"]);
assert.deepEqual(commandPersists, [["c", "a", "b"]]);
firstController.dispose();
assert.deepEqual(await reorderWorkspaceByCommand("a", "up"), {
  ok: true,
  previousIds: ["c", "a", "b"],
});
assert.deepEqual(commandProjects.map((project) => project.id), ["a", "c", "b"]);
assert.deepEqual(await reorderWorkspaceByCommand("a", "up"), {
  ok: false,
  error: "NO_ORDER_CHANGE",
});
assert.deepEqual(await reorderWorkspaceByCommand("b", "down"), {
  ok: false,
  error: "NO_ORDER_CHANGE",
});
assert.deepEqual(await reorderWorkspaceByCommand("missing", "up"), {
  ok: false,
  error: "WORKSPACE_NOT_FOUND",
});
assert.deepEqual(await reorderWorkspaceByCommand("a", "sideways"), {
  ok: false,
  error: "INVALID_WORKSPACE_ORDER_COMMAND",
});
secondController.dispose();
assert.deepEqual(await reorderWorkspaceByCommand("a", "up"), {
  ok: false,
  error: "WORKSPACE_ORDER_NOT_INITIALIZED",
});
secondController.dispose();

const filteredController = initWorkspaceOrder({
  ...sharedDeps,
  isFilterActive: () => true,
});
assert.deepEqual(await reorderWorkspaceByCommand("b", "up"), {
  ok: false,
  error: "WORKSPACE_ORDER_FILTER_ACTIVE",
});
filteredController.dispose();

let undoProjects = [...commitProjects];
const undoPersists = [];
const undoToasts = [];
const undoController = initWorkspaceOrder({
  getProjects: () => undoProjects,
  setProjects: (next) => {
    undoProjects = next;
  },
  persist: async (ids) => {
    undoPersists.push([...ids]);
    return { ok: true, state: { projects: ids.map((id) => ({ id })) } };
  },
  isFilterActive: () => false,
  showActionToast: (_message, _label, action) => {
    const toast = {
      action,
      removed: false,
      remove() {
        this.removed = true;
      },
    };
    undoToasts.push(toast);
    return toast;
  },
});
await reorderWorkspaceByCommand("c", "top");
await reorderWorkspaceByCommand("b", "top");
assert.equal(undoToasts.length, 2);
assert.equal(undoToasts[0].removed, true, "a newer successful sort should close the previous undo toast");
assert.deepEqual(await undoToasts[0].action(), {
  ok: false,
  error: "WORKSPACE_ORDER_UNDO_STALE",
});
assert.equal(undoPersists.length, 2, "a stale undo must not persist");
assert.equal((await undoToasts[1].action()).ok, true);
assert.equal(undoPersists.length, 3, "the latest undo should persist");
assert.deepEqual(undoProjects.map((project) => project.id), ["c", "a", "b"]);
undoController.dispose();

const appSource = fs.readFileSync(
  new URL("../src/renderer/app.js", import.meta.url),
  "utf8",
);
assert.match(appSource, /document\.activeElement/);
assert.match(appSource, /\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
assert.match(appSource, /project-header-main/);

const projectTreeSource = fs.readFileSync(
  new URL("../src/renderer/modules/project-tree.js", import.meta.url),
  "utf8",
);
const projectHeaderSource = fs.readFileSync(
  new URL("../src/renderer/modules/workspace-project-header.js", import.meta.url),
  "utf8",
);
const projectTreeUiSource = `${projectTreeSource}\n${projectHeaderSource}`;
assert.match(projectTreeUiSource, /setAttribute\("role", "list"\)/);
assert.match(projectTreeUiSource, /setAttribute\("role", "listitem"\)/);
assert.match(projectTreeUiSource, /className = "project-header-main"/);
assert.match(projectTreeUiSource, /headerMain\.setAttribute\("aria-expanded"/);
assert.match(projectTreeUiSource, /const info = document\.createElement\("span"\)/);
assert.doesNotMatch(projectTreeUiSource, /setAttribute\("role", "treeitem"\)/);
assert.doesNotMatch(projectTreeUiSource, /header\.tabIndex/);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.style = {};
    this.scrollTop = 0;
    this._capturedPointers = new Set();
    this._rect = { top: 0, bottom: 40, height: 40 };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.remove();
    child.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  get parentElement() {
    return this.parentNode;
  }

  matches(selector) {
    if (!selector.startsWith(".")) return false;
    const name = selector.slice(1);
    return this.classList.contains(name) || String(this.className).split(/\s+/).includes(name);
  }

  closest(selector) {
    const selectors = selector.split(",").map((part) => part.trim());
    let current = this;
    while (current) {
      for (const part of selectors) {
        if (part.startsWith(".") && current.matches(part)) return current;
        if (part === "button" && current.tagName === "BUTTON") return current;
        if (part === "a" && current.tagName === "A") return current;
        if (part === "input" && current.tagName === "INPUT") return current;
        if (part === "textarea" && current.tagName === "TEXTAREA") return current;
        if (part === "select" && current.tagName === "SELECT") return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  setPointerCapture(pointerId) {
    this._capturedPointers.add(pointerId);
  }

  releasePointerCapture(pointerId) {
    this._capturedPointers.delete(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this._capturedPointers.has(pointerId);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      relatedTarget: null,
      propagationStopped: false,
      immediatePropagationStopped: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
        this.propagationStopped = true;
      },
      ...init,
    };

    let current = this;
    while (current && !event.propagationStopped) {
      event.currentTarget = current;
      const listeners = [...(current.listeners.get(type) || [])];
      for (const entry of listeners) {
        entry.listener(event);
        if (event.immediatePropagationStopped) break;
        if (entry.once) {
          const remaining = (current.listeners.get(type) || []).filter((item) => item !== entry);
          current.listeners.set(type, remaining);
        }
      }
      current = current.parentNode;
    }
    return event;
  }
}

function createFakeDocument() {
  const body = new FakeElement("body");
  const findById = (root, id) => {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };
  return {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(body, id),
  };
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.due;
        timer.callback();
      }
      now = target;
    },
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

const originalDocument = globalThis.document;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalDateNow = Date.now;
const originalConsoleError = console.error;
const fakeClock = createFakeClock();
globalThis.document = createFakeDocument();
globalThis.requestAnimationFrame = (callback) => callback();
globalThis.setTimeout = fakeClock.setTimeout;
globalThis.clearTimeout = fakeClock.clearTimeout;
Date.now = fakeClock.now;

try {
  function createWorkspaceTree() {
    const view = new FakeElement("window");
    const tree = new FakeElement("div");
    tree.id = "projectTree";
    tree.dataset.filterActive = "false";
    tree._rect = { top: 0, bottom: 240, height: 240 };

    const createGroup = (id, top) => {
      const group = new FakeElement("div");
      group.className = "project-group";
      group.dataset.projectId = id;
      group._rect = { top, bottom: top + 40, height: 40 };
      const header = new FakeElement("div");
      header.className = "project-header";
      const main = new FakeElement("button");
      main.className = "project-header-main";
      main.dataset.projectId = id;
      const target = new FakeElement("span");
      target.className = "project-name";
      const handle = new FakeElement("button");
      handle.className = "workspace-drag-handle";
      main.appendChild(target);
      header.appendChild(main);
      header.appendChild(handle);
      group.appendChild(header);
      tree.appendChild(group);
      return { group, header, main, target, handle };
    };

    return {
      view,
      tree,
      first: createGroup("a", 40),
      second: createGroup("b", 100),
    };
  }

  const candidateFixture = createWorkspaceTree();
  const candidateController = initWorkspaceOrder({
    tree: candidateFixture.tree,
    window: candidateFixture.view,
    getProjects: () => [{ id: "a" }, { id: "b" }],
    setProjects() {},
    persist: async (ids) => ({
      ok: true,
      state: { projects: ids.map((id) => ({ id })) },
    }),
  });
  candidateFixture.first.target.dispatch("pointerdown", {
    pointerId: 11,
    clientX: 10,
    clientY: 60,
    button: 0,
    isPrimary: true,
  });
  assert.equal(
    candidateFixture.first.target.hasPointerCapture(11),
    true,
    "long-press candidates should capture the pointer immediately",
  );
  candidateFixture.first.target._capturedPointers.delete(11);
  candidateFixture.first.target.dispatch("lostpointercapture", { pointerId: 11 });
  fakeClock.tick(300);
  assert.equal(
    candidateFixture.tree.classList.contains("workspace-ordering"),
    false,
    "lost capture should cancel the candidate instead of activating after the hold delay",
  );

  candidateFixture.first.target.dispatch("pointerdown", {
    pointerId: 12,
    clientX: 10,
    clientY: 60,
    button: 0,
    isPrimary: true,
  });
  candidateFixture.first.target.dispatch("pointermove", {
    pointerId: 12,
    clientX: 20,
    clientY: 60,
  });
  assert.equal(
    candidateFixture.first.target.hasPointerCapture(12),
    false,
    "slop cancellation should release candidate pointer capture",
  );

  candidateFixture.first.target.dispatch("pointerdown", {
    pointerId: 13,
    clientX: 10,
    clientY: 60,
    button: 0,
    isPrimary: true,
  });
  candidateFixture.tree.dataset.filterActive = "true";
  candidateFixture.tree.dispatch("workspace-filter-change", { detail: { query: "a" } });
  assert.equal(
    candidateFixture.first.target.hasPointerCapture(13),
    false,
    "starting a filter should release candidate pointer capture",
  );
  candidateController.dispose();

  const activeFixture = createWorkspaceTree();
  const activeControllerForTest = initWorkspaceOrder({
    tree: activeFixture.tree,
    window: activeFixture.view,
    getProjects: () => [{ id: "a" }, { id: "b" }],
    setProjects() {},
    persist: async (ids) => ({
      ok: true,
      state: { projects: ids.map((id) => ({ id })) },
    }),
  });
  activeFixture.first.handle.dispatch("pointerdown", {
    pointerId: 21,
    clientX: 10,
    clientY: 60,
    button: 0,
    isPrimary: true,
  });
  assert.equal(activeFixture.tree.classList.contains("workspace-ordering"), true);
  activeFixture.first.handle._capturedPointers.delete(21);
  activeFixture.first.handle.dispatch("lostpointercapture", { pointerId: 21 });
  assert.equal(
    activeFixture.tree.classList.contains("workspace-ordering"),
    false,
    "lost capture should safely cancel an active drag",
  );

  activeFixture.first.handle.dispatch("pointerdown", {
    pointerId: 22,
    clientX: 10,
    clientY: 60,
    button: 0,
    isPrimary: true,
  });
  activeFixture.first.handle.dispatch("pointerup", {
    pointerId: 22,
    clientX: 10,
    clientY: 60,
  });
  const otherWorkspaceClick = activeFixture.second.main.dispatch("click");
  assert.equal(
    otherWorkspaceClick.defaultPrevented,
    false,
    "drag click suppression must not consume a different workspace click",
  );
  const sourceWorkspaceClick = activeFixture.first.main.dispatch("click");
  assert.equal(
    sourceWorkspaceClick.defaultPrevented,
    true,
    "the immediate synthetic click for the drag source should be consumed",
  );

  activeFixture.first.handle.dispatch("pointerdown", {
    pointerId: 23,
    clientX: 10,
    clientY: 60,
    button: 0,
    isPrimary: true,
  });
  activeFixture.first.handle.dispatch("pointerup", {
    pointerId: 23,
    clientX: 10,
    clientY: 60,
  });
  fakeClock.tick(601);
  const expiredSourceClick = activeFixture.first.main.dispatch("click");
  assert.equal(expiredSourceClick.defaultPrevented, false, "click suppression should expire");
  activeControllerForTest.dispose();

  const keyboardFixture = createWorkspaceTree();
  let keyboardProjects = [{ id: "a" }, { id: "b" }];
  const keyboardPersists = [];
  const keyboardController = initWorkspaceOrder({
    tree: keyboardFixture.tree,
    window: keyboardFixture.view,
    getProjects: () => keyboardProjects,
    setProjects: (next) => {
      keyboardProjects = next;
    },
    persist: async (ids) => {
      keyboardPersists.push([...ids]);
      return { ok: true, state: { projects: ids.map((id) => ({ id })) } };
    },
  });
  const keyboardEvent = keyboardFixture.first.main.dispatch("keydown", {
    key: "ArrowDown",
    altKey: true,
  });
  await flushMicrotasks();
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.deepEqual(keyboardPersists, [["b", "a"]]);
  assert.deepEqual(keyboardProjects.map((project) => project.id), ["b", "a"]);
  keyboardController.dispose();

  const errors = [];
  console.error = (...args) => errors.push(args);
  const { showActionToast, showToast } = await import("../src/renderer/modules/toast.js");

  const ordinaryTimedToast = showToast("Saved", "info", 100);
  fakeClock.tick(99);
  assert.notEqual(ordinaryTimedToast.dataset.toastRemoving, "true");
  fakeClock.tick(1);
  assert.equal(ordinaryTimedToast.dataset.toastRemoving, "true");
  const ordinaryClickedToast = showToast("Saved", "info", 0);
  ordinaryClickedToast.dispatch("click");
  ordinaryClickedToast.dispatch("click");
  assert.equal(ordinaryClickedToast.dataset.toastRemoving, "true");

  let successCalls = 0;
  let resolveSuccess;
  const successToast = showActionToast(
    "Reordered",
    "Undo",
    () => {
      successCalls += 1;
      return new Promise((resolve) => {
        resolveSuccess = resolve;
      });
    },
    "success",
    1000,
  );
  const successAction = successToast.children.at(-1);
  successAction.dispatch("click");
  successAction.dispatch("click");
  await flushMicrotasks();
  assert.equal(successCalls, 1);
  assert.equal(successAction.disabled, true);
  assert.equal(successToast.dataset.actionState, "pending");
  assert.notEqual(successToast.dataset.toastRemoving, "true");
  resolveSuccess();
  await flushMicrotasks();
  assert.equal(successToast.dataset.toastRemoving, "true");

  const failedToast = showActionToast(
    "Reordered",
    "Undo",
    async () => ({ ok: false, error: "SAVE_FAILED" }),
    "success",
    1000,
  );
  const failedAction = failedToast.children.at(-1);
  failedAction.dispatch("click");
  await flushMicrotasks();
  assert.equal(failedAction.disabled, false);
  assert.equal(failedAction.getAttribute("aria-busy"), "false");
  assert.equal(failedAction.getAttribute("aria-invalid"), "true");
  assert.equal(failedToast.dataset.actionState, "failed");
  assert.notEqual(failedToast.dataset.toastRemoving, "true");
  assert.equal(errors.length, 1);
  fakeClock.tick(999);
  assert.notEqual(failedToast.dataset.toastRemoving, "true");
  fakeClock.tick(1);
  assert.equal(failedToast.dataset.toastRemoving, "true");

  const rejectedToast = showActionToast(
    "Reordered",
    "Undo",
    async () => {
      throw new Error("undo failed");
    },
    "success",
    0,
  );
  const rejectedAction = rejectedToast.children.at(-1);
  rejectedAction.dispatch("click");
  await flushMicrotasks();
  assert.equal(rejectedAction.disabled, false);
  assert.equal(rejectedToast.dataset.actionState, "failed");
  assert.notEqual(rejectedToast.dataset.toastRemoving, "true");
  assert.equal(errors.length, 2);

  const hoverToast = showActionToast("Reordered", "Undo", () => undefined, "success", 1000);
  fakeClock.tick(400);
  hoverToast.dispatch("pointerenter");
  fakeClock.tick(2000);
  assert.notEqual(hoverToast.dataset.toastRemoving, "true");
  hoverToast.dispatch("pointerleave");
  fakeClock.tick(599);
  assert.notEqual(hoverToast.dataset.toastRemoving, "true");
  fakeClock.tick(1);
  assert.equal(hoverToast.dataset.toastRemoving, "true");

  const focusToast = showActionToast("Reordered", "Undo", () => undefined, "success", 1000);
  const focusAction = focusToast.children.at(-1);
  fakeClock.tick(200);
  focusToast.dispatch("focusin");
  fakeClock.tick(2000);
  assert.notEqual(focusToast.dataset.toastRemoving, "true");
  focusToast.dispatch("focusout", { relatedTarget: focusAction });
  fakeClock.tick(2000);
  assert.notEqual(focusToast.dataset.toastRemoving, "true");
  focusToast.dispatch("focusout", { relatedTarget: null });
  fakeClock.tick(799);
  assert.notEqual(focusToast.dataset.toastRemoving, "true");
  fakeClock.tick(1);
  assert.equal(focusToast.dataset.toastRemoving, "true");

  const persistentToast = showActionToast("Reordered", "Undo", () => undefined, "success", 0);
  fakeClock.tick(100000);
  assert.notEqual(persistentToast.dataset.toastRemoving, "true");
} finally {
  globalThis.document = originalDocument;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalDateNow;
  console.error = originalConsoleError;
}

console.log("workspace-order-model: ok");
