#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { WORKBENCH_EXAMPLE_KEYS, listHasWorkbenchContent } = await import(
  path.join(ROOT, "src/renderer/modules/workbench-empty.js")
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
