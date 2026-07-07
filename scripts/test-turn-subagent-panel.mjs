#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderSubagentStatusPanel } from "../src/renderer/modules/turn-subagent-panel.js";

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

assert.equal(renderSubagentStatusPanel([]), null, "empty subagent panels should not render");

const entry = {
  status: "done",
  title: "Inspect renderer",
  result: { content: "summary" },
  subagent: {
    phaseDetail: "reading files",
    textPreview: "live preview should be hidden when done",
    textFull: "hello\nworld",
    tools: [{ name: "Read", input: { file_path: "/tmp/a.js" } }],
  },
};
const panel = renderSubagentStatusPanel([entry], false, {
  summary: () => "1 complete",
  isOpen: () => true,
  label: () => "Reviewer",
  description: () => "Inspect renderer",
  statusText: () => "Done",
  phaseLabel: () => "Finished",
  metadata: () => "session sub_1",
  stats: () => "2 tools",
  currentTool: () => ({ name: "Read", input: { file_path: "/tmp/a.js" } }),
  toolPreview: () => "Read /tmp/a.js",
  normalizeResult: (result) => result,
  transcriptText: () => "Output\nhello\nworld",
  translate: (key, params = {}) => key === "subagent.currentTool"
    ? `${params.tool}: ${params.detail}`
    : key,
});

assert.equal(panel.className, "assistant-subagent-panel");
assert.equal(panel.open, true);
assert.equal(panel.children[0].className, "assistant-subagent-panel-summary");
assert.equal(panel.children[0].textContent, "1 complete");
const list = panel.children[1];
assert.equal(list.className, "assistant-subagent-list");
const row = list.children[0];
assert.equal(row.className, "assistant-subagent-row");
assert.equal(row.dataset.status, "done");
assert.equal(row.children[0].children[0].textContent, "Reviewer · Inspect renderer");
assert.equal(row.children[0].children[1].textContent, "Done");
assert.equal(row.children[1].children[0].textContent, "Finished");
assert.equal(row.children[1].children[1].textContent, "reading files");
assert.equal(row.children[2].textContent, "session sub_1");
assert.equal(row.children[3].textContent, "2 tools");
assert.equal(row.children[4].textContent, "Read: Read /tmp/a.js");
assert.equal(row.children[5].className, "assistant-subagent-result");
assert.equal(row.children[5].textContent, "summary");
assert.equal(row.children[6].className, "assistant-subagent-transcript");
assert.equal(row.children[6].open, false);
assert.equal(row.children[6].children[0].textContent, "subagent.transcript");
assert.equal(row.children[6].children[1].textContent, "Output\nhello\nworld");

const runningPanel = renderSubagentStatusPanel(
  [{ status: "running", subagent: { textPreview: "preview" } }],
  false,
  {
    summary: () => "running",
    isOpen: () => false,
    label: () => "Worker",
    description: () => "Task",
    statusText: () => "Running",
    phaseLabel: () => "Running",
    metadata: () => "",
    stats: () => "",
    currentTool: () => null,
    normalizeResult: () => null,
    transcriptText: () => "",
    translate: (key) => key,
  },
);
assert.equal(runningPanel.open, false);
assert.equal(runningPanel.children[1].children[0].children[2].className, "assistant-subagent-preview");
assert.equal(runningPanel.children[1].children[0].children[2].textContent, "preview");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderSubagentStatusPanel"),
  false,
  "turn-view-renderer should delegate subagent panel DOM to turn-subagent-panel",
);

console.log("turn-subagent-panel: ok");
