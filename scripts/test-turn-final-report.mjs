#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  finalReportView,
  renderFinalReport,
} from "../src/renderer/modules/turn-final-report.js";

const translate = (key) => ({ "message.resultLabel": "Result" }[key] || key);
const reportTurn = {
  phase: "done",
  final: { type: "turn.completed", payload: { assistant: "Answer", resultFromCli: true } },
  timeline: [
    { kind: "tool", id: "tool_1", name: "Read", status: "done" },
  ],
};

assert.equal(
  finalReportView(reportTurn, { text: "Answer" }, { hasExistingReport: true, sealed: true, translate }),
  null,
  "final report view should not render twice",
);
assert.equal(
  finalReportView({ phase: "done", final: { type: "turn.completed", payload: { assistant: "Answer" } }, tools: new Map() }, { text: "Answer" }, { sealed: true, translate }),
  null,
  "final report view should preserve shouldShowFinal gating",
);
assert.deepEqual(
  finalReportView(reportTurn, { text: "Answer" }, { sealed: true, translate }),
  {
    label: "Result",
    text: "Answer",
    sealed: true,
  },
  "final report view should expose label, narrative text, and sealed render mode",
);
assert.deepEqual(
  finalReportView(reportTurn, null, { sealed: false, translate }),
  {
    label: "Result",
    text: "",
    sealed: false,
  },
  "final report view should tolerate missing narrative data",
);

function element(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
    children: [],
    append(...nodes) {
      this.children.push(...nodes);
    },
    appendChild(node) {
      this.children.push(node);
    },
    querySelector(selector) {
      if (selector === '[data-role="artifacts"]') return this.artifacts || null;
      return null;
    },
    insertBefore(node, before) {
      this.inserted = { node, before };
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const sealedEvents = [];
const article = element("article");
article.artifacts = element("div");
renderFinalReport(article, { label: "Result", text: "Final text", sealed: true }, {
  renderStreaming(root, text) {
    sealedEvents.push(["stream", root.className, text]);
  },
  renderFinal(root, text) {
    sealedEvents.push(["final", root.className, text]);
  },
  requestIdle(fn) {
    sealedEvents.push(["idle"]);
    fn();
  },
});
assert.equal(article.inserted.before, article.artifacts, "final report should insert before artifacts when possible");
assert.equal(article.inserted.node.className, "assistant-turn-report");
assert.equal(article.inserted.node.children[0].textContent, "Result");
assert.deepEqual(
  sealedEvents,
  [
    ["stream", "assistant-turn-final markdown-body assistant-turn-report-body", "Final text"],
    ["idle"],
    ["final", "assistant-turn-final markdown-body assistant-turn-report-body", "Final text"],
  ],
  "sealed final report should stream first and schedule a full markdown upgrade",
);

const unsealedEvents = [];
const fallbackArticle = element("article");
renderFinalReport(fallbackArticle, { label: "Result", text: "Draft text", sealed: false }, {
  renderContent(root, text) {
    unsealedEvents.push(["content", root.className, text]);
  },
});
assert.equal(fallbackArticle.children[0].className, "assistant-turn-report");
assert.deepEqual(
  unsealedEvents,
  [["content", "assistant-turn-final markdown-body assistant-turn-report-body", "Draft text"]],
  "unsealed final report should use content block markdown rendering",
);

console.log("turn-final-report: ok");
