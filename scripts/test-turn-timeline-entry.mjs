#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  renderTimelineEntry,
  renderToolWithChildren,
} from "../src/renderer/modules/turn-timeline-entry.js";

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

function node(label) {
  const item = document.createElement("div");
  item.textContent = label;
  return item;
}

const calls = [];
const deps = {
  isTodo: (name) => name === "TodoWrite",
  renderThinking: (entry, live) => {
    calls.push(["thinking", entry.id, live]);
    return node(`thinking:${live}`);
  },
  renderToolGroup: (entry, sealed, ctx, options) => {
    calls.push(["toolGroup", entry.id, sealed, ctx.sessionId, typeof options.renderTool]);
    return node(`toolGroup:${entry.id}`);
  },
  renderTodo: (entry, options) => {
    calls.push(["todo", entry.id, options.isLatest]);
    return node(`todo:${entry.id}:${options.isLatest}`);
  },
  renderToolRow: (entry, sealed, ctx) => {
    calls.push(["tool", entry.id, sealed, ctx.sessionId]);
    return node(`tool:${entry.id}`);
  },
  renderNotice: (entry) => node(`notice:${entry.id}`),
  renderText: (entry, live) => node(`text:${entry.id}:${live}`),
  statusLabel: () => "status",
  durationSuffix: () => "",
};

assert.equal(
  renderTimelineEntry({ kind: "thinking", id: "think_1" }, false, {}, deps).textContent,
  "thinking:true",
);
assert.equal(
  renderTimelineEntry({ kind: "thinking", id: "think_2" }, true, {}, deps).textContent,
  "thinking:false",
);
assert.equal(
  renderTimelineEntry({ kind: "tool", id: "todo_live", name: "TodoWrite" }, false, {}, deps),
  null,
  "live TodoWrite renders in the pinned strip, not inline",
);
assert.equal(
  renderTimelineEntry({ kind: "tool", id: "todo_done", name: "TodoWrite" }, true, { latestTodoId: "todo_done" }, deps).textContent,
  "todo:todo_done:true",
);
assert.equal(
  renderTimelineEntry({ kind: "toolGroup", id: "group_1" }, true, { sessionId: "s1" }, deps).textContent,
  "toolGroup:group_1",
);
assert.equal(
  renderTimelineEntry({ kind: "notice", id: "notice_1" }, false, {}, deps).textContent,
  "notice:notice_1",
);
assert.equal(
  renderTimelineEntry({ kind: "text", id: "text_1" }, false, {}, deps).textContent,
  "text:text_1:true",
);
assert.equal(renderTimelineEntry({ kind: "unknown", id: "x" }, false, {}, deps), null);

const parent = renderToolWithChildren(
  { kind: "tool", id: "parent", name: "Bash" },
  false,
  new Map([["parent", [{ kind: "tool", id: "child", name: "Read" }]]]),
  { sessionId: "s2" },
  deps,
);
assert.equal(parent.textContent, "tool:parent");
assert.equal(parent.children[0].className, "assistant-subagent-tools");
assert.equal(parent.children[0].children[0].textContent, "tool:child");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderTimelineEntry"),
  false,
  "turn-view-renderer should delegate timeline entry routing to turn-timeline-entry",
);
assert.equal(
  rendererSource.includes("function renderToolWithChildren"),
  false,
  "turn-view-renderer should delegate nested tool rendering to turn-timeline-entry",
);

console.log("turn-timeline-entry: ok");
