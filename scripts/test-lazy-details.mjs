#!/usr/bin/env node
/**
 * Folded step rows are built when someone opens them, and a re-render still
 * restores what was open inside them.
 *
 * With the archived timeline no longer cut to its last 100 entries, a page of
 * long finished turns holds thousands of step rows inside collapsed groups —
 * every one of them built on every session switch before this, unseen.
 */
import assert from "node:assert/strict";

const { lazyDetails } = await import("../src/renderer/modules/lazy-details.js");
const { collectDetailsOpenState, restoreDetailsOpenState } = await import("../src/renderer/modules/turn-details-open-state.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

// The minimum of a DOM these modules touch: nested <details>, dataset,
// classList, toggle listeners, querySelectorAll("details") in document order.
function el(tag, { className = "", toolId = "" } = {}) {
  const node = {
    tagName: tag.toUpperCase(), className, children: [], open: false, listeners: {},
    dataset: toolId ? { toolId } : {},
    classList: { contains: (name) => className.split(" ").includes(name) },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (selector === "details" && c.tagName === "DETAILS") out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
  return node;
}
const toggle = (details) => { for (const fn of details.listeners.toggle || []) fn(); };

function renderTurn(builds) {
  const root = el("div");
  const group = el("details", { className: "assistant-process-group" });
  root.appendChild(group);
  lazyDetails(group, () => {
    builds.group += 1;
    for (let i = 0; i < 3; i += 1) {
      const toolRow = el("details", { className: "tool", toolId: `call_${i}` });
      lazyDetails(toolRow, () => { builds.rows += 1; toolRow.appendChild(el("pre")); });
      group.appendChild(toolRow);
    }
  });
  return { root, group };
}

{
  const builds = { group: 0, rows: 0 };
  const { group } = renderTurn(builds);
  assert.deepEqual(builds, { group: 0, rows: 0 }, "a collapsed group builds nothing");
  group.open = true; toggle(group); toggle(group);
  assert.equal(builds.group, 1, "opening builds its content, once");
  assert.equal(builds.rows, 0, "and rows inside stay unbuilt until they are opened");
  check("folded content is built on first open and only once");
}

{
  // The user opened the group and the second step; the turn re-renders.
  const builds = { group: 0, rows: 0 };
  const before = renderTurn(builds);
  before.group.open = true; toggle(before.group);
  before.group.children[1].open = true; toggle(before.group.children[1]);
  const state = collectDetailsOpenState(before.root);

  const rebuilt = { group: 0, rows: 0 };
  const after = renderTurn(rebuilt);
  restoreDetailsOpenState(after.root, state);
  assert.equal(after.group.open, true, "the group reopens");
  assert.equal(after.group.children[1].open, true, "and the step that was open inside it reopens too");
  assert.equal(after.group.children[0].open, false, "a step that was closed stays closed");
  assert.equal(rebuilt.group, 1);
  check("restoring open state builds the groups that reopen, so items inside them are restored as well");
}

{
  const builds = { group: 0, rows: 0 };
  const { root } = renderTurn(builds);
  restoreDetailsOpenState(root, new Map([["assistant-process-group", false]]));
  assert.deepEqual(builds, { group: 0, rows: 0 }, "a group that stays closed is never built by a re-render");
  check("a re-render never builds a group that stays closed");
}

console.log(`lazy-details: ok (${checks} checks)`);
