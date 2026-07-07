#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTurnArticleLayout } from "../src/renderer/modules/turn-article-layout.js";

function node(role) {
  return {
    role,
    className: "",
    hidden: false,
    dataset: { role },
  };
}

function article(nodes) {
  return {
    children: [...nodes],
    appended: [],
    querySelector(selector) {
      const match = selector.match(/\[data-role="([^"]+)"\]/);
      const role = match?.[1];
      return this.children.find((child) => child.dataset?.role === role) || null;
    },
    append(...next) {
      this.appended.push(next.map((child) => child.dataset.role));
      this.children = [...next];
    },
  };
}

const created = [];
globalThis.document = {
  createElement(tagName) {
    assert.equal(tagName, "div");
    const el = {
      tagName,
      className: "",
      hidden: false,
      dataset: {},
    };
    created.push(el);
    return el;
  },
};

const ordered = [
  node("header"),
  node("process"),
  node("taskrun"),
  node("narrative"),
  node("artifacts"),
  node("footer"),
  node("prompts"),
];
const stable = article(ordered);
normalizeTurnArticleLayout(stable, ordered.map((item) => item.dataset.role));
assert.equal(stable.appended.length, 0, "already-normalized layout should not re-append nodes");

const mixed = article([
  node("header"),
  node("narrative"),
  node("process"),
  node("footer"),
  node("prompts"),
]);
normalizeTurnArticleLayout(mixed, ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"]);
assert.deepEqual(
  mixed.children.map((child) => child.dataset.role),
  ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"],
  "layout normalization should create missing optional slots and restore the stable turn order",
);
assert.equal(created[0].className, "assistant-turn-taskrun");
assert.equal(created[0].hidden, true);
assert.equal(created[1].className, "assistant-turn-artifacts");
assert.equal(created[1].hidden, true);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function normalizeTurnArticleLayout"),
  false,
  "turn-view-renderer should consume the article layout helper instead of owning it",
);

console.log("turn-article-layout: ok");
