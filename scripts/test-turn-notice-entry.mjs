#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderNoticeEntry } from "../src/renderer/modules/turn-notice-entry.js";

function element(tagName) {
  const classes = new Set();
  const node = {
    tagName,
    className: "",
    textContent: "",
    dataset: {},
    attributes: {},
    style: {},
    children: [],
    classList: {
      add(name) {
        classes.add(name);
        node.className = `${node.className} ${name}`.trim();
      },
      contains(name) {
        return classes.has(name);
      },
    },
    appendChild(child) {
      this.children.push(child);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  return node;
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

assert.equal(
  renderNoticeEntry({ level: "info" }, { resolveDetail: () => "" }),
  null,
  "notice entries without detail should not render",
);

const plain = renderNoticeEntry({ level: "warning" }, {
  resolveDetail: () => "Careful",
  resolveProgressPercent: () => null,
});
assert.equal(plain.className, "assistant-process-notice is-warning");
assert.equal(plain.textContent, "Careful");

const liveness = renderNoticeEntry({ code: "toolProgress", level: "progress" }, {
  resolveDetail: () => "write 正在运行 · 已运行 33s · 最近活动 33s 前",
  resolveProgressPercent: () => null,
});
assert.equal(liveness.className, "assistant-process-notice is-progress is-liveness");
assert.equal(liveness.textContent, "write 正在运行 · 已运行 33s · 最近活动 33s 前");

const progress = renderNoticeEntry({ level: "info", progress: { percent: 33 } }, {
  resolveDetail: () => "Downloading",
  resolveProgressPercent: () => 33.4,
});
assert.equal(progress.className, "assistant-process-notice is-info is-progress");
assert.equal(progress.classList.contains("is-progress"), true);
assert.equal(progress.children[0].className, "assistant-process-notice-text");
assert.equal(progress.children[0].textContent, "Downloading");
const track = progress.children[1];
assert.equal(track.className, "assistant-process-progress-track");
assert.equal(track.attributes.role, "progressbar");
assert.equal(track.attributes["aria-valuemin"], "0");
assert.equal(track.attributes["aria-valuemax"], "100");
assert.equal(track.attributes["aria-valuenow"], "33");
assert.equal(track.children[0].className, "assistant-process-progress-fill");
assert.equal(track.children[0].style.width, "33.4%");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderNoticeEntry"),
  false,
  "turn-view-renderer should consume the notice renderer instead of owning it",
);

console.log("turn-notice-entry: ok");
