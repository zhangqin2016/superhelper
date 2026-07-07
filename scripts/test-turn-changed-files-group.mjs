#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderChangedFilesGroup } from "../src/renderer/modules/turn-changed-files-group.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    textContent: "",
    title: "",
    open: true,
    children: [],
    listeners: {},
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

const t = (key, params = {}) => {
  const table = {
    "timeline.changedFiles": `Changed ${params.count}`,
    "file.reveal": "Reveal",
    "timeline.revertTurn": "Revert",
    "timeline.revertTurnConfirmTitle": "Confirm revert",
    "timeline.revertTurnConfirmMessage": `Revert ${params.count} files?`,
    "timeline.revertTurnUndo": "Undo revert",
    "timeline.revertTurnDone": "Reverted",
    "timeline.revertTurnUndone": "Undo done",
    "timeline.revertTurnUndoFailed": "Undo failed",
    "timeline.revertTurnFailed": `Failed ${params.files}`,
  };
  return table[key] ?? key;
};

const revealed = [];
const toasts = [];
const confirms = [];
const clientCalls = [];
const deps = {
  translate: t,
  revealFile: (filePath) => revealed.push(filePath),
  confirm: async (opts) => {
    confirms.push(opts);
    return true;
  },
  toast: (message, type) => toasts.push({ message, type }),
  assistantClient: {
    async revertTurn(sessionId, turnId) {
      clientCalls.push(["revert", sessionId, turnId]);
      return { ok: true };
    },
    async unrevertTurn(sessionId, turnId) {
      clientCalls.push(["unrevert", sessionId, turnId]);
      return { ok: true };
    },
  },
};

const group = renderChangedFilesGroup(
  [
    { fileName: "app.js", filePath: "/tmp/app.js" },
    { filePath: "/tmp/only-path.txt" },
  ],
  false,
  { sessionId: "session_1", turnId: "turn_1" },
  deps,
);

assert.equal(group.className, "assistant-process-group assistant-process-group-changes");
assert.equal(group.open, false);
assert.equal(group.children[0].textContent, "Changed 2");
const list = group.children[1];
assert.equal(list.className, "assistant-process-changes-list");
assert.equal(list.children[0].className, "assistant-process-change-row is-clickable");
assert.equal(list.children[0].textContent, "app.js");
assert.equal(list.children[0].title, "/tmp/app.js — Reveal");
assert.equal(list.children[1].textContent, "/tmp/only-path.txt");
list.children[0].listeners.click();
assert.deepEqual(revealed, ["/tmp/app.js"]);

const revertButton = group.children[2];
assert.equal(revertButton.className, "assistant-turn-revert-btn");
assert.equal(revertButton.textContent, "Revert");
await revertButton.listeners.click({ preventDefault() {} });
assert.deepEqual(confirms, [{ title: "Confirm revert", message: "Revert 2 files?", danger: true }]);
assert.deepEqual(clientCalls, [["revert", "session_1", "turn_1"]]);
assert.equal(revertButton.dataset.reverted, "true");
assert.equal(revertButton.textContent, "Undo revert");
assert.deepEqual(toasts, [{ message: "Reverted", type: "success" }]);

await revertButton.listeners.click({ preventDefault() {} });
assert.deepEqual(clientCalls, [
  ["revert", "session_1", "turn_1"],
  ["unrevert", "session_1", "turn_1"],
]);
assert.equal(revertButton.dataset.reverted, "false");
assert.equal(revertButton.textContent, "Revert");
assert.deepEqual(toasts.at(-1), { message: "Undo done", type: "success" });

const noActionGroup = renderChangedFilesGroup(
  [{ fileName: "no-session", filePath: "/tmp/no-session" }],
  false,
  {},
  deps,
);
assert.equal(noActionGroup.children.length, 2, "revert button requires both sessionId and turnId");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderChangedFilesGroup"),
  false,
  "turn-view-renderer should delegate changed-files DOM to turn-changed-files-group",
);

console.log("turn-changed-files-group: ok");
