#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToolRow } from "../src/renderer/modules/turn-tool-row.js";

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

const calls = [];
const tool = {
  id: "tool_1",
  name: "Write",
  status: "done",
  input: { file_path: "/tmp/out.md" },
  result: { content: "ok" },
};
const row = renderToolRow(
  tool,
  "Write /tmp/out.md",
  true,
  " · 1.2s",
  { sessionId: "session_1" },
  {
    filePath: () => "/tmp/out.md",
    preview: () => "fallback preview",
    statusLabel: () => "Done",
    appendResult: (node, passedTool, sealed, ctx) => {
      calls.push([node.className, passedTool.id, sealed, ctx.sessionId]);
      const detail = document.createElement("pre");
      detail.className = "result";
      node.appendChild(detail);
    },
  },
);

assert.equal(row.className, "assistant-tool-row");
assert.equal(row.dataset.toolId, "tool_1");
assert.equal(row.dataset.toolFilePath, "/tmp/out.md");
assert.equal(row.dataset.status, "done");
assert.equal(row.open, false);
const summary = row.children[0];
assert.equal(summary.className, "assistant-tool-summary");
const head = summary.children[0];
assert.equal(head.className, "assistant-tool-row-head");
assert.equal(head.children[0].className, "assistant-tool-command");
assert.equal(head.children[0].textContent, "Write /tmp/out.md");
assert.equal(head.children[1].className, "assistant-tool-status");
assert.equal(head.children[1].textContent, "Done · 1.2s");
assert.deepEqual(calls, [["assistant-tool-row", "tool_1", true, "session_1"]]);
assert.equal(row.children[1].className, "result");

const fallback = renderToolRow(
  { id: "tool_2", status: "running" },
  "",
  false,
  "",
  {},
  {
    filePath: () => "",
    preview: () => "fallback preview",
    statusLabel: () => "Running",
    appendResult: () => {},
  },
);
assert.equal(fallback.children[0].children[0].children[0].textContent, "fallback preview");
assert.equal(fallback.dataset.toolFilePath, undefined);

const defaultStatus = renderToolRow(
  { id: "tool_3", status: "done", result: null },
  "Default status",
);
assert.ok(
  defaultStatus.children[0].children[0].children[1].textContent,
  "default status label should render without injected dependencies",
);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderToolRow("),
  false,
  "turn-view-renderer should delegate tool row DOM to turn-tool-row",
);

console.log("turn-tool-row: ok");
