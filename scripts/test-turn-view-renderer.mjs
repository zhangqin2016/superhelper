#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  THINKING_SUMMARY_MAX,
  thinkingSummaryPreview,
  buildThinkingSummaryLabel,
  timelineForView,
  buildLiveStatusText,
  buildStatusText,
  buildStatusFooterText,
} from "../src/renderer/modules/turn-view-status.js";

const translate = (key, params = {}) => {
  const table = {
    "turn.thinking.title": "思考中",
    "turn.thinking.liveSummary": `思考中 · ${params.preview || ""}`,
    "turn.status.thinking": "思考中",
    "turn.status.starting": "正在启动…",
    "turn.status.waiting": "等待回复",
    "turn.status.working": "处理中…",
    "turn.status.live": `${params.seconds}s · ${params.activity}`,
    "turn.status.awaitingUser": "等待你确认",
    "turn.status.failed": "处理失败",
    "turn.footer.duration": `耗时 ${params.seconds}s`,
    "turn.footer.tokens": `${params.count} tokens`,
    "turn.footer.tokensDetail": `输入 ${params.input} · 输出 ${params.output} tokens`,
  };
  return table[key] ?? key;
};

assert.equal(thinkingSummaryPreview("short"), "short");
const long = "a".repeat(THINKING_SUMMARY_MAX + 10);
const preview = thinkingSummaryPreview(long);
assert.ok(preview.startsWith("…"));
assert.equal(preview.length, THINKING_SUMMARY_MAX);

assert.equal(buildThinkingSummaryLabel("plan", false, translate), "思考中");
assert.equal(
  buildThinkingSummaryLabel("先分析章节结构再写开场", true, translate),
  "思考中 · 先分析章节结构再写开场",
);

const notice = {
  kind: "notice",
  code: "apiRetry",
  level: "warning",
  detail: "retrying request",
};
const liveTurn = {
  phase: "streaming",
  thinkingText: "",
  startedAt: 1_000,
  updatedAt: 1_000,
  tools: new Map(),
  timeline: [notice],
};
const sealedTurn = {
  ...liveTurn,
  timeline: [notice],
  final: {
    type: "turn.completed",
    payload: { assistant: "done", durationMs: 8000, record: { usage: { estimatedTokens: 1200 } } },
  },
  durationMs: 8000,
  usage: { estimatedTokens: 1200 },
};

assert.equal(timelineForView(liveTurn, false).length, 0, "live hides notices");
assert.equal(timelineForView(sealedTurn, true).length, 1, "sealed keeps notices");

const now = 16_000;
assert.equal(
  buildLiveStatusText({ ...liveTurn, thinkingText: "planning" }, translate, now),
  "15s · 思考中",
);

assert.equal(
  buildStatusText({ phase: "awaiting_user" }, {}, translate, now),
  "等待你确认",
);

assert.equal(
  buildStatusText(sealedTurn, { sealed: true }, translate, now),
  "耗时 8s · 1.2k tokens",
);

assert.equal(
  buildStatusFooterText(sealedTurn, translate),
  "耗时 8s · 1.2k tokens",
);

console.log("turn-view-renderer: ok");
