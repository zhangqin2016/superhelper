#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  planCapabilityReadiness,
  resolveCapabilityReadiness,
} = require("../src/main/capability-readiness.js");

const browser = planCapabilityReadiness({
  text: "打开 localhost 截图并检查控制台",
  files: [],
});
assert.deepEqual(browser.requiredPackIds, ["web-automation"]);
assert.deepEqual(browser.enhancementPackIds, []);
assert.equal(browser.fallbackCapabilityIds.includes("code-static-review"), true);

const simplePdf = planCapabilityReadiness({
  text: "总结这份 PDF",
  files: [{ name: "a.pdf" }],
});
assert.deepEqual(simplePdf.requiredPackIds, []);
assert.equal(simplePdf.enhancementPackIds.includes("pro-pdf"), true);
assert.equal(simplePdf.enhancementPackIds.includes("large-document"), true);

const complexPdf = planCapabilityReadiness({
  text: "恢复复杂 PDF 的表格结构和阅读顺序",
  files: [{ name: "layout.pdf" }],
});
assert.equal(complexPdf.requiredPackIds.includes("pro-pdf"), true);
assert.equal(complexPdf.enhancementPackIds.includes("large-document"), true);

const media = planCapabilityReadiness({
  text: "把这个视频转码成 mp4",
  files: [{ name: "clip.mov" }],
});
assert.deepEqual(media.requiredPackIds, ["ffmpeg"]);

const ready = resolveCapabilityReadiness(browser, {
  installedPackIds: new Set(["web-automation"]),
  installingPackIds: new Set(),
  unavailablePackIds: new Set(),
});
assert.equal(ready.status, "ready");

const missing = resolveCapabilityReadiness(browser, {
  installedPackIds: new Set(),
  installingPackIds: new Set(),
  unavailablePackIds: new Set(),
});
assert.equal(missing.status, "preparing");
assert.deepEqual(missing.missingRequiredPackIds, ["web-automation"]);

const unavailable = resolveCapabilityReadiness(browser, {
  installedPackIds: new Set(),
  installingPackIds: new Set(),
  unavailablePackIds: new Set(["web-automation"]),
});
assert.equal(unavailable.status, "degraded");
assert.deepEqual(unavailable.unavailablePackIds, ["web-automation"]);

console.log("capability-readiness: ok");
