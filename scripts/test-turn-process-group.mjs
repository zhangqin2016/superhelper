#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderProcessGroup } from "../src/renderer/modules/turn-process-group.js";

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
    append(...items) {
      for (const item of items) this.appendChild(item);
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const group = renderProcessGroup({
  processTools: [{ id: "tool_1" }],
  notices: [{ id: "notice_1" }],
  sealed: true,
  childTools: new Map(),
  entryCtx: { sessionId: "session_1" },
}, {
  processSummary: (tools, notices) => `tools:${tools.length}/notices:${notices.length}`,
  renderGrouped: (body, tools, notices, sealed, childTools, entryCtx) => {
    const marker = document.createElement("div");
    marker.className = "grouped-marker";
    marker.textContent = `${tools[0].id}:${notices[0].id}:${sealed}:${entryCtx.sessionId}:${childTools.size}`;
    body.appendChild(marker);
  },
});

assert.equal(group.className, "assistant-process-group");
assert.equal(group.open, false);
assert.equal(group.children[0].tagName, "summary");
assert.equal(group.children[0].textContent, "tools:1/notices:1");
assert.equal(group.children[1].className, "assistant-process-group-body");
assert.equal(group.children[1].children[0].textContent, "tool_1:notice_1:true:session_1:0");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("assistant-process-group-body"),
  false,
  "turn-view-renderer should delegate collapsed process group DOM to turn-process-group",
);

console.log("turn-process-group: ok");
