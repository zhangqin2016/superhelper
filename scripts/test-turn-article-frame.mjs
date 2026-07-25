#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  refreshLiveTurnStatusDisplay,
  syncTurnArticleFrame,
} from "../src/renderer/modules/turn-article-frame.js";

function articleStub() {
  const classes = new Set();
  const nodes = {
    '[data-role="status"]': { textContent: "", hidden: false },
    '[data-role="header"]': { hidden: false },
    '[data-role="footer"]': { id: "footer" },
  };
  return {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    dataset: {},
    nodes,
    querySelector(selector) {
      return nodes[selector] || null;
    },
  };
}

const article = articleStub();
const calls = [];
syncTurnArticleFrame(article, { final: { type: "turn.completed" } }, {
  articleClassFlags: { isSealed: true, isLive: false, isWorking: false },
  slotOrder: ["header", "process", "narrative"],
}, {
  failed: true,
  sealed: true,
}, {
  normalizeLayout: (target, order) => calls.push(["layout", target === article, order.join(",")]),
  refreshStatus: (target, turn, options) => calls.push(["status", target === article, turn.final.type, options.failed, options.sealed]),
  renderFooterSlot: (root, turn, sealed) => calls.push(["footer", root.id, turn.final.type, sealed]),
});

assert.equal(article.classList.contains("is-sealed"), true);
assert.equal(article.classList.contains("is-live"), false);
assert.equal(article.classList.contains("is-working"), false);
assert.equal(article.dataset.terminal, "failed");
assert.deepEqual(calls, [
  ["layout", true, "header,process,narrative"],
  ["status", true, "turn.completed", true, true],
  ["footer", "footer", "turn.completed", true],
]);

const statusArticle = articleStub();
refreshLiveTurnStatusDisplay(statusArticle, { final: { type: "turn.completed" } }, {
  sealed: true,
  failed: false,
}, {
  buildStatus: () => "Done",
  applyStatus: (status, text, options) => {
    status.textContent = text;
    status.hidden = !text;
    calls.push(["apply", text, options.sealed, options.live]);
  },
});
assert.equal(statusArticle.nodes['[data-role="header"]'].hidden, false);
assert.deepEqual(calls.at(-1), ["apply", "Done", true, false]);

refreshLiveTurnStatusDisplay(statusArticle, {}, {}, {
  buildStatus: () => "",
  applyStatus: (status, text) => {
    status.textContent = text;
    status.hidden = !text;
  },
});
assert.equal(statusArticle.nodes['[data-role="header"]'].hidden, true);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("articleClassFlags"),
  false,
  "turn-view-renderer should delegate article frame class/layout/status/footer sync",
);

console.log("turn-article-frame: ok");
