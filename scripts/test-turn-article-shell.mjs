#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLiveTurnArticleShell } from "../src/renderer/modules/turn-article-shell.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    textContent: "",
    hidden: false,
    children: [],
    append(...children) {
      this.children.push(...children);
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const article = createLiveTurnArticleShell(
  {
    turnId: "turn_1",
    phase: "streaming",
    startedAt: 1000,
    updatedAt: 1500,
  },
  {
    statusText: () => "Working",
    slotOrder: ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"],
  },
);

assert.equal(article.tagName, "article");
assert.equal(article.className, "assistant-turn-article is-live");
assert.equal(article.dataset.turnId, "turn_1");
assert.deepEqual(
  article.children.map((child) => child.dataset.role),
  ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"],
);
assert.equal(article.children[0].className, "assistant-turn-header");
assert.equal(article.children[0].children[0].className, "assistant-turn-status is-live-status");
assert.equal(article.children[0].children[0].textContent, "Working");
assert.equal(article.children[1].className, "assistant-turn-process");
assert.equal(article.children[2].className, "assistant-turn-taskrun");
assert.equal(article.children[2].hidden, true);
assert.equal(article.children[3].className, "assistant-turn-narrative markdown-body");
assert.equal(article.children[4].className, "assistant-turn-artifacts");
assert.equal(article.children[4].hidden, true);
assert.equal(article.children[5].className, "assistant-turn-footer");
assert.equal(article.children[5].hidden, true);
assert.equal(article.children[6].className, "assistant-turn-prompts");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function createLiveTurnArticleShell"),
  false,
  "turn-view-renderer should delegate article shell creation to turn-article-shell",
);

console.log("turn-article-shell: ok");
