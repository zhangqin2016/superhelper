#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchLiveProcessDom } from "../src/renderer/modules/turn-live-process-patch.js";

function leaf(props = {}) {
  return {
    textContent: "",
    scrollTop: 0,
    scrollHeight: 42,
    dataset: {},
    ...props,
    querySelector(selector) {
      return this.nodes?.[selector] || null;
    },
  };
}

function rootWith(nodes = {}) {
  return {
    nodes,
    querySelector(selector) {
      return this.nodes[selector] || null;
    },
  };
}

globalThis.CSS = {
  escape(value) {
    return String(value).replace(/"/g, '\\"');
  },
};

const summary = leaf({ textContent: "old summary" });
const cmd = leaf({ textContent: "old cmd" });
const status = leaf({ textContent: "old status" });
const row = leaf({
  dataset: { status: "running" },
  nodes: {
    ".assistant-tool-command": cmd,
    ".assistant-tool-status": status,
  },
});
const thinkingSummary = leaf({ textContent: "old thinking" });
const thinkingPre = leaf({ textContent: "old text", scrollTop: 0, scrollHeight: 99 });
const thinkingGroup = leaf({
  nodes: {
    ".assistant-process-thinking": thinkingPre,
    ".assistant-process-thinking-summary": thinkingSummary,
  },
});
const inlineText = leaf();

const root = rootWith({
  ".assistant-process-group summary": summary,
  '.assistant-tool-row[data-tool-id="tool_1"]': row,
  '.assistant-process-thinking-group[data-thinking-id="think_1"]': thinkingGroup,
  '.assistant-turn-inline-text[data-text-id="text_1"]': inlineText,
});

const patched = patchLiveProcessDom(root, { final: null }, {}, {
  timelineForProcess: () => [
    { kind: "tool", id: "todo_1", name: "TodoWrite" },
    { kind: "tool", id: "sub_1", name: "Task", subagent: true },
    { kind: "tool", id: "tool_1", name: "Bash", status: "done" },
    { kind: "thinking", id: "think_1", text: " new text ", status: "running" },
    { kind: "text", id: "text_1" },
  ],
  partition: () => ({
    thinking: [],
    notices: [{ kind: "notice" }],
    tools: [
      { kind: "tool", id: "todo_1", name: "TodoWrite" },
      { kind: "tool", id: "sub_1", name: "Task", subagent: true },
      { kind: "tool", id: "tool_1", name: "Bash", status: "done" },
    ],
  }),
  processSummary: (tools, notices) => `tools:${tools.length}/notices:${notices.length}`,
  isTodo: (name) => name === "TodoWrite",
  isSubagent: (entry) => Boolean(entry.subagent),
  rowPreview: () => "new cmd",
  toRenderTool: () => ({ status: "done", name: "bash" }),
  toolStatus: () => "Done",
  toolDuration: () => " · 1.2s",
  thinkingSummary: () => "Thinking live",
});

assert.equal(patched, true);
assert.equal(summary.textContent, "tools:1/notices:1");
assert.equal(cmd.textContent, "new cmd");
assert.equal(status.textContent, "Done · 1.2s");
assert.equal(row.dataset.status, "done");
assert.equal(thinkingSummary.textContent, "Thinking live");
assert.equal(thinkingPre.textContent, "new text");
assert.equal(thinkingPre.scrollTop, 99);

assert.equal(
  patchLiveProcessDom(rootWith({}), {}, {}, {
    timelineForProcess: () => [{ kind: "tool", id: "missing", name: "Bash" }],
    partition: () => ({ thinking: [], notices: [], tools: [] }),
    isTodo: () => false,
    isSubagent: () => false,
    rowPreview: () => "",
    toRenderTool: (entry) => entry,
    toolStatus: () => "",
    toolDuration: () => "",
  }),
  false,
  "missing tool rows should force a full process re-render",
);
assert.equal(
  patchLiveProcessDom(root, {}, {}, {
    timelineForProcess: () => [{ kind: "toolGroup", id: "group_1" }],
    partition: () => ({ thinking: [], notices: [], tools: [] }),
  }),
  false,
  "tool groups change structure and should force full re-render",
);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function patchLiveProcessDom"),
  false,
  "turn-view-renderer should delegate live process patching to turn-live-process-patch",
);

console.log("turn-live-process-patch: ok");
