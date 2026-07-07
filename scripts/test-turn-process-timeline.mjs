#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderProcessTimeline } from "../src/renderer/modules/turn-process-timeline.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
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

function node(className, textContent = "") {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = textContent;
  return el;
}

const childToolIds = new Set(["child_1"]);
const list = renderProcessTimeline({
  timeline: [
    { kind: "thinking", id: "think_1", text: "a" },
    { kind: "thinking", id: "think_2", text: "b" },
    { kind: "tool", id: "todo_1", name: "TodoWrite" },
    { kind: "tool", id: "tool_1", name: "Bash" },
    { kind: "tool", id: "child_1", name: "Read" },
    { kind: "text", id: "text_1" },
  ],
  thinking: [{ id: "think_1" }, { id: "think_2" }],
  notices: [{ id: "notice_1" }],
  collapsed: true,
  groupThinking: true,
  childTools: new Map(),
  childToolIds,
  processTools: [{ id: "tool_1" }],
  entryCtx: { sessionId: "session_1" },
  hasDiffs: true,
  diffEntries: [{ filePath: "/tmp/a.js" }],
  subagents: [{ id: "sub_1" }],
}, {
  sealed: true,
  sessionId: "session_1",
  turnId: "turn_1",
  renderSubagents: () => node("subagents", "sub_1"),
  renderGroup: () => node("group", "grouped"),
  renderThinking: () => node("thinking-stack", "think_1,think_2"),
  renderEntry: (entry) => node(`entry-${entry.kind}`, entry.id),
  renderChanges: (entries, sealed, ctx) => node("changes", `${entries.length}:${sealed}:${ctx.sessionId}:${ctx.turnId}`),
});

assert.equal(list.className, "assistant-turn-timeline");
assert.deepEqual(
  list.children.map((child) => `${child.className}:${child.textContent}`),
  [
    "subagents:sub_1",
    "thinking-stack:think_1,think_2",
    "entry-tool:todo_1",
    "group:grouped",
    "entry-text:text_1",
    "changes:1:true:session_1:turn_1",
  ],
  "collapsed process timelines should preserve subagents, grouped thinking, in-place todos/text, group anchor, and changes",
);

const flat = renderProcessTimeline({
  timeline: [
    { kind: "thinking", id: "think_1", text: "a" },
    { kind: "tool", id: "tool_1", name: "Bash" },
  ],
  thinking: [{ id: "think_1" }],
  collapsed: false,
  groupThinking: false,
  childToolIds: new Set(),
  entryCtx: {},
}, {
  renderEntry: (entry) => node(`entry-${entry.kind}`, entry.id),
});
assert.deepEqual(
  flat.children.map((child) => `${child.className}:${child.textContent}`),
  ["entry-thinking:think_1", "entry-tool:tool_1"],
  "flat process timelines should render entries chronologically",
);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("assistant-turn-timeline"),
  false,
  "turn-view-renderer should delegate process timeline DOM assembly",
);

console.log("turn-process-timeline: ok");
