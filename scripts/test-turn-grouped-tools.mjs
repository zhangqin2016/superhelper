#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderGroupedTools } from "../src/renderer/modules/turn-grouped-tools.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
    open: true,
    children: [],
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

function toolNode(entry) {
  const node = document.createElement("div");
  node.className = "tool-row";
  node.textContent = entry.id;
  return node;
}

function noticeNode(entry) {
  const node = document.createElement("div");
  node.className = "notice-row";
  node.textContent = entry.id;
  return node;
}

const flatContainer = document.createElement("div");
renderGroupedTools(
  flatContainer,
  [{ id: "read_1", category: "read" }, { id: "read_2", category: "read" }],
  [{ id: "notice_1" }],
  false,
  new Map(),
  {},
  {
    groupTools: (tools) => new Map([["read", tools]]),
    renderTool: toolNode,
    renderNotice: noticeNode,
  },
);
assert.deepEqual(
  flatContainer.children.map((child) => `${child.className}:${child.textContent}`),
  ["tool-row:read_1", "tool-row:read_2", "notice-row:notice_1"],
  "single-category groups should append tool rows directly before notices",
);

const groupedContainer = document.createElement("div");
renderGroupedTools(
  groupedContainer,
  [{ id: "read_1" }, { id: "write_1" }],
  [],
  true,
  new Map(),
  {},
  {
    groupTools: () => new Map([
      ["read", [{ id: "read_1" }]],
      ["write", [{ id: "write_1" }]],
    ]),
    categorySummary: (category, count) => [`summary.${category}`, { count }],
    translate: (key, params) => `${key}:${params.count}`,
    renderTool: toolNode,
    renderNotice: noticeNode,
  },
);
assert.equal(groupedContainer.children.length, 2);
assert.equal(groupedContainer.children[0].className, "assistant-process-subgroup");
assert.equal(groupedContainer.children[0].open, false);
assert.equal(groupedContainer.children[0].children[0].textContent, "summary.read:1");
assert.equal(groupedContainer.children[0].children[1].className, "assistant-process-subgroup-body");
assert.equal(groupedContainer.children[0].children[1].children[0].textContent, "read_1");
assert.equal(groupedContainer.children[1].children[0].textContent, "summary.write:1");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderGroupedTools"),
  false,
  "turn-view-renderer should delegate grouped tool DOM to turn-grouped-tools",
);

console.log("turn-grouped-tools: ok");
