#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTodoEntry, renderTodoItems } from "../src/renderer/modules/turn-todo-entry.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    textContent: "",
    open: false,
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    replaceChildren(...children) {
      this.children = children;
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const translate = (key, vars) => {
  assert.equal(key, "todo.summary");
  return `${vars.done}/${vars.total}`;
};

assert.equal(
  renderTodoEntry({ id: "empty" }, { parseTodos: () => [], translate }),
  null,
  "empty todo snapshots should not render",
);

const entry = renderTodoEntry({ id: "todo_1" }, {
  isLatest: false,
  translate,
  parseTodos: () => [
    { status: "completed", content: "Done" },
    { status: "in_progress", content: "Doing" },
    { status: "pending", content: "Later" },
  ],
});
assert.equal(entry.className, "assistant-todo-card");
assert.equal(entry.dataset.toolId, "todo_1");
assert.equal(entry.open, false, "non-latest todo snapshots should stay collapsed");
assert.equal(entry.children[0].className, "assistant-todo-summary");
assert.equal(entry.children[0].textContent, "1/3");
assert.equal(entry.children[1].className, "assistant-todo-items");
assert.deepEqual(
  entry.children[1].children.map((item) => [item.className, item.textContent]),
  [
    ["assistant-todo-item is-completed", "✓ Done"],
    ["assistant-todo-item is-in_progress", "▸ Doing"],
    ["assistant-todo-item is-pending", "○ Later"],
  ],
  "todo items should preserve status class and icon text",
);

const list = element("ul");
renderTodoItems(list, [{ status: "completed", content: "Only" }]);
assert.deepEqual(list.children.map((item) => item.textContent), ["✓ Only"]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderTodoEntry"),
  false,
  "turn-view-renderer should consume the todo renderer instead of owning it",
);
assert.equal(
  rendererSource.includes("function renderTodoItems"),
  false,
  "turn-view-renderer should consume todo item rendering instead of owning it",
);

console.log("turn-todo-entry: ok");
