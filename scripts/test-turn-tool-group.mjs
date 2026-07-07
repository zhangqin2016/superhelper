#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToolGroup } from "../src/renderer/modules/turn-tool-group.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    textContent: "",
    open: true,
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

assert.equal(
  renderToolGroup({ id: "empty", tools: [] }),
  null,
  "empty tool groups should not render",
);

const row = renderToolGroup(
  {
    id: "group_1",
    status: "done",
    startTs: 1000,
    ts: 2600,
    tools: [{ id: "tool_1" }, { id: "tool_2" }],
  },
  true,
  { sessionId: "session_1" },
  {
    translate: (key, params) => `${key}:${params.count}`,
    statusLabel: (entry) => `status:${entry.status || entry}`,
    durationSuffix: () => " · 1.6s",
    renderTool: (entry, sealed, ctx) => {
      const child = document.createElement("div");
      child.className = "child-tool";
      child.textContent = `${entry.id}:${sealed}:${ctx.sessionId}`;
      return child;
    },
  },
);

assert.equal(row.className, "assistant-tool-row assistant-tool-group-row");
assert.equal(row.dataset.toolId, "group_1");
assert.equal(row.dataset.status, "done");
assert.equal(row.open, false);
const summary = row.children[0];
assert.equal(summary.className, "assistant-tool-summary");
const head = summary.children[0];
assert.equal(head.className, "assistant-tool-row-head");
assert.equal(head.children[0].className, "assistant-tool-command");
assert.equal(head.children[0].textContent, "timeline.readGroup:2");
assert.equal(head.children[1].className, "assistant-tool-status");
assert.equal(head.children[1].textContent, "status:done · 1.6s");
const body = row.children[1];
assert.equal(body.className, "assistant-tool-group-body");
assert.deepEqual(
  body.children.map((child) => child.textContent),
  ["tool_1:true:session_1", "tool_2:true:session_1"],
);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderToolGroup"),
  false,
  "turn-view-renderer should delegate tool group DOM to turn-tool-group",
);

console.log("turn-tool-group: ok");
