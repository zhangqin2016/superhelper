#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderTaskRunSummary } from "../src/renderer/modules/turn-taskrun-summary.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    hidden: false,
    textContent: "",
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    querySelector(selector) {
      const className = selector.startsWith(".") ? selector.slice(1) : "";
      const queue = [...this.children];
      while (queue.length) {
        const item = queue.shift();
        if (item.className === className) return item;
        queue.push(...(item.children || []));
      }
      return null;
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const hiddenRoot = element("div");
hiddenRoot.replaceChildren(element("details"));
renderTaskRunSummary(hiddenRoot, { taskRun: { status: "done" } }, false, {
  summarizeTaskRun() {
    return "should not show";
  },
});
assert.equal(hiddenRoot.hidden, true, "unsealed task run summary should stay hidden");
assert.equal(hiddenRoot.children.length, 0, "hidden task run summary should clear stale content");

const root = element("div");
renderTaskRunSummary(root, { taskRun: { status: "done" } }, true, {
  translate(key) {
    assert.equal(key, "task.summary.title");
    return "Task summary";
  },
  summarizeTaskRun(taskRun) {
    assert.deepEqual(taskRun, { status: "done" });
    return "Finished in 3 steps";
  },
});
const details = root.querySelector(".assistant-taskrun-summary");
const title = root.querySelector(".assistant-taskrun-summary-title");
const body = root.querySelector(".assistant-taskrun-summary-body");
assert.equal(root.hidden, false, "sealed task run summary should be visible when a summary exists");
assert.equal(details.tagName, "details");
assert.equal(title.textContent, "Task summary");
assert.equal(body.textContent, "Finished in 3 steps");

renderTaskRunSummary(root, {
  final: { payload: { record: { meta: { taskRun: { status: "interrupted" } } } } },
}, true, {
  translate() {
    return "Task summary";
  },
  summarizeTaskRun(taskRun) {
    assert.deepEqual(taskRun, { status: "interrupted" });
    return "Interrupted";
  },
});
assert.equal(root.querySelector(".assistant-taskrun-summary-body").textContent, "Interrupted");
assert.equal(root.children[0], details, "existing task run details should be reused");

renderTaskRunSummary(root, { taskRun: { status: "done" } }, true, {
  summarizeTaskRun() {
    throw new Error("bad task metadata");
  },
});
assert.equal(root.hidden, true, "summary failures should hide the task run region");
assert.equal(root.children.length, 0, "summary failures should clear stale task run content");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderTaskRunSummary"),
  false,
  "turn-view-renderer should consume the task run summary helper instead of owning it",
);

console.log("turn-taskrun-summary: ok");
