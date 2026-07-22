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
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
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

// Speaker row comes first: a direct child of the article (NOT inside the header,
// which turn-article-frame hides when empty) so it survives both live and sealed turns.
const speaker = article.children[0];
assert.equal(speaker.className, "assistant-turn-speaker");
assert.equal(speaker.children[0].className, "assistant-turn-avatar");
assert.equal(speaker.children[0].textContent, "L");
assert.equal(speaker.children[0].attributes["aria-hidden"], "true");
assert.equal(speaker.children[1].className, "assistant-turn-name");
assert.equal(speaker.children[1].textContent, "Lily");

assert.deepEqual(
  article.children.slice(1).map((child) => child.dataset.role),
  ["header", "process", "taskrun", "narrative", "artifacts", "footer", "prompts"],
);
assert.equal(article.children[1].className, "assistant-turn-header");
assert.equal(article.children[1].children[0].className, "assistant-turn-status is-live-status");
assert.equal(article.children[1].children[0].textContent, "Working");
assert.equal(article.children[2].className, "assistant-turn-process");
assert.equal(article.children[3].className, "assistant-turn-taskrun");
assert.equal(article.children[3].hidden, true);
assert.equal(article.children[4].className, "assistant-turn-narrative markdown-body");
assert.equal(article.children[5].className, "assistant-turn-artifacts");
assert.equal(article.children[5].hidden, true);
assert.equal(article.children[6].className, "assistant-turn-footer");
assert.equal(article.children[6].hidden, true);
assert.equal(article.children[7].className, "assistant-turn-prompts");

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
