#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { WORKBENCH_EXAMPLE_KEYS, listHasWorkbenchContent, buildWorkbenchEmpty } = await import(
  pathToFileURL(path.join(ROOT, "src/renderer/modules/workbench-empty.js")).href
);

assert.equal(WORKBENCH_EXAMPLE_KEYS.length, 3, "workbench should expose three example prompts");
assert.ok(
  WORKBENCH_EXAMPLE_KEYS.every((key) => key.startsWith("workbench.example")),
  "example keys should stay namespaced",
);

assert.equal(listHasWorkbenchContent(null), false);
assert.equal(listHasWorkbenchContent(undefined), false);

const listEl = {
  children: [
    { classList: { contains: (c) => c === "workbench-empty" } },
  ],
};
assert.equal(listHasWorkbenchContent(listEl), false, "empty state alone is not content");

const withMessage = {
  children: [
    { classList: { contains: (c) => c === "workbench-empty" } },
    { classList: { contains: () => false } },
  ],
};
assert.equal(listHasWorkbenchContent(withMessage), true, "any non-empty node hides workbench");

console.log("workbench-empty: ok");

// Exercise the real click handlers, including composer input listeners.
const input = new EventTarget();
input.value = "";
input.focus = () => { input.focused = true; };
let changes = 0;
input.addEventListener("input", event => {
  assert.equal(event.bubbles, true);
  assert.ok(input.value);
  changes += 1;
});
globalThis.document = {
  getElementById: id => id === "promptInput" ? input : null,
  createElement: () => ({
    children: [], handlers: {}, setAttribute() {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
    append(...children) { this.children.push(...children); },
  }),
};
const root = buildWorkbenchEmpty();
for (const button of root.children[3].children) button.handlers.click();
assert.equal(changes, 3, "every starter updates Send, autosize and draft through input");
assert.equal(input.focused, true);
console.log("workbench-empty: starter input lifecycle ok");
