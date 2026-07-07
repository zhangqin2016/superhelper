#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendToolResultBlock } from "../src/renderer/modules/turn-tool-result-block.js";

function element(tagName) {
  return {
    tagName,
    type: "",
    className: "",
    dataset: {},
    textContent: "",
    children: [],
    listeners: {},
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const t = (key) => ({
  "tool.expand": "Expand",
  "tool.collapse": "Collapse",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.copyFailed": "Copy failed",
}[key] || key);

const payloadCalls = [];
const deps = {
  translate: t,
  toast: (message, type) => payloadCalls.push(["toast", message, type]),
  writeClipboard: async (text) => payloadCalls.push(["clipboard", text]),
  classifyTool: (name) => name === "Write" ? "write" : "other",
  inputHasDetail: (tool) => Boolean(tool.inputDetail),
  appendPayloadDetail: (row, tool, options) => {
    payloadCalls.push(["payload", tool.id, options.role, options.compactFileContent, options.sessionId]);
    const node = document.createElement("div");
    node.className = `payload-${options.role}`;
    row.appendChild(node);
  },
  parseResult: (result) => result,
  parseMedia: (text) => text.includes("[media]") ? [{ url: "x" }] : [],
  normalizeResult: (result) => result,
};

const noResultRow = document.createElement("details");
appendToolResultBlock(noResultRow, { id: "none", result: null }, false, {}, deps);
assert.equal(noResultRow.children.length, 0, "tools without result should not append result DOM");

const plainRow = document.createElement("details");
appendToolResultBlock(
  plainRow,
  { id: "plain", result: { content: "short output", truncated: false } },
  false,
  {},
  deps,
);
assert.equal(plainRow.children.length, 1);
assert.equal(plainRow.children[0].className, "assistant-tool-detail assistant-tool-result");
assert.equal(plainRow.children[0].textContent, "short output");

const truncatedRow = document.createElement("details");
appendToolResultBlock(
  truncatedRow,
  { id: "truncated", result: { content: "short", truncated: true, fullText: "long full text" } },
  false,
  {},
  deps,
);
assert.equal(truncatedRow.children[0].textContent, "short");
const actions = truncatedRow.children[1];
assert.equal(actions.className, "assistant-tool-detail-actions");
const expandBtn = actions.children[0];
const copyBtn = actions.children[1];
assert.equal(expandBtn.textContent, "Expand");
expandBtn.listeners.click();
assert.equal(truncatedRow.children[0].dataset.expanded, "true");
assert.equal(truncatedRow.children[0].textContent, "long full text");
assert.equal(expandBtn.textContent, "Collapse");
await copyBtn.listeners.click();
assert.deepEqual(payloadCalls.at(-2), ["clipboard", "long full text"]);
assert.deepEqual(payloadCalls.at(-1), ["toast", "Copied", "success"]);

const structuredRow = document.createElement("details");
appendToolResultBlock(
  structuredRow,
  { id: "structured", result: { content: "summary", extra: true } },
  true,
  { sessionId: "session_1" },
  deps,
);
assert.deepEqual(payloadCalls.at(-1), ["payload", "structured", "result", undefined, "session_1"]);
assert.equal(structuredRow.children[0].className, "payload-result");

const inputRow = document.createElement("details");
appendToolResultBlock(
  inputRow,
  { id: "write_1", name: "Write", inputDetail: true, result: { content: "ok" } },
  true,
  { sessionId: "session_2" },
  deps,
);
assert.deepEqual(payloadCalls.at(-1), ["payload", "write_1", "input", true, "session_2"]);
assert.equal(inputRow.children[0].className, "payload-input");

const mediaRow = document.createElement("details");
appendToolResultBlock(
  mediaRow,
  { id: "media", result: { content: "[media]" } },
  false,
  { sessionId: "session_3" },
  deps,
);
assert.deepEqual(payloadCalls.at(-1), ["payload", "media", "result", undefined, "session_3"]);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function appendToolResultBlock"),
  false,
  "turn-view-renderer should delegate tool result DOM to turn-tool-result-block",
);

console.log("turn-tool-result-block: ok");
