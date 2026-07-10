#!/usr/bin/env node
// Surgical heartbeat: running tool rows tick their clock via a targeted text
// update — never a full article re-render (the visual signature deliberately
// excludes elapsed time).
import assert from "node:assert/strict";
import { patchLiveToolClocks } from "../src/renderer/modules/turn-live-clock-patch.js";

const translate = (key) => ({
  "tool.status.running": "正在运行",
  "tool.status.done": "已完成",
  "tool.status.failed": "失败",
  "tool.status.commandDone": "终端已运行",
}[key] || key);

function fakeRow(toolId, statusText = "") {
  const status = { textContent: statusText };
  return {
    dataset: { toolId },
    querySelector: (selector) => (selector === ".assistant-tool-status" ? status : null),
    status,
  };
}

function fakeArticle(rows) {
  return { querySelectorAll: () => rows };
}

const startTs = 1_000_000;
const now = startTs + 33_400;

{
  const runningRow = fakeRow("w1");
  const doneRow = fakeRow("r1", "已完成 · 0.8s");
  const article = fakeArticle([runningRow, doneRow]);
  const liveTurn = {
    timeline: [
      { kind: "tool", id: "r1", name: "read", status: "done", startTs, ts: startTs + 800 },
      { kind: "tool", id: "w1", name: "write", status: "running", startTs },
    ],
  };
  const patched = patchLiveToolClocks(article, liveTurn, { now, translate });
  assert.equal(patched, 1, "only the running row is touched");
  assert.equal(runningRow.status.textContent, "正在运行 · 33.4s", "the running row shows a live elapsed clock");
  assert.equal(doneRow.status.textContent, "已完成 · 0.8s", "finished rows are never rewritten");
}

{
  const article = fakeArticle([fakeRow("w1", "正在运行 · 33.4s")]);
  const liveTurn = { timeline: [{ kind: "tool", id: "w1", name: "write", status: "running", startTs }] };
  assert.equal(
    patchLiveToolClocks(article, liveTurn, { now, translate }),
    0,
    "an unchanged clock text is not rewritten (no DOM churn)",
  );
}

{
  const liveTurn = { timeline: [{ kind: "tool", id: "w1", name: "write", status: "done", startTs, ts: now }] };
  assert.equal(
    patchLiveToolClocks(fakeArticle([fakeRow("w1")]), liveTurn, { now, translate }),
    0,
    "nothing running → nothing scanned or patched",
  );
  assert.equal(patchLiveToolClocks(null, liveTurn, { now, translate }), 0, "missing article fails open");
  assert.equal(patchLiveToolClocks(fakeArticle([]), null, { now, translate }), 0, "missing live turn fails open");
}

console.log("turn-live-clock-patch: ok");
