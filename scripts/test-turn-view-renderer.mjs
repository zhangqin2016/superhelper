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
  taskRunSummaryForView,
} from "../src/renderer/modules/turn-view-status.js";

const translate = (key, params = {}) => {
  const table = {
    "turn.thinking.title": "思考中",
    "turn.thinking.liveSummary": `思考中 · ${params.preview || ""}`,
    "turn.thinking.doneSummary": `思考了 ${params.seconds} 秒`,
    "turn.status.escHint": "Esc 停止",
    "turn.thinking.liveSummaryTimed": `思考中 ${params.seconds}s · ${params.preview || ""}`,
    "turn.status.thinking": "思考中",
    "turn.status.starting": "正在启动…",
    "turn.status.waiting": "等待回复",
    "turn.status.working": "处理中…",
    "turn.status.tool.bash": "运行命令…",
    "turn.status.tool.generic": "调用工具…",
    "turn.status.live": `${params.seconds}s · ${params.activity}`,
    "turn.status.awaitingUser": "等待你确认",
    "turn.status.stopping": "正在停止…",
    "turn.status.failed": "处理失败",
    "turn.footer.duration": `耗时 ${params.seconds}s`,
    "turn.footer.tokens": `${params.count} tokens`,
    "turn.footer.tokensDetail": `输入 ${params.input} · 输出 ${params.output} tokens`,
    "task.summary.compact": `${params.status}/${params.evidence}/${params.risks}/${params.verification}`,
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
// Sealed thinking blocks summarize how long the model thought, so the
// collapsed line carries information instead of a bare title.
assert.equal(
  buildThinkingSummaryLabel(
    { kind: "thinking", text: "plan", startTs: 1000, ts: 13000, status: "done" },
    false,
    translate,
  ),
  "思考了 12 秒",
);
assert.equal(
  buildThinkingSummaryLabel(
    { kind: "thinking", text: "plan", startTs: 1000, ts: 1200, status: "done" },
    false,
    translate,
  ),
  "思考中",
);
// Streaming blocks tick with the latest delta timestamp so the user sees how
// long the model has been thinking; sub-second blocks keep the plain label.
assert.equal(
  buildThinkingSummaryLabel(
    { kind: "thinking", text: "正在推导方案", startTs: 1000, ts: 5000 },
    true,
    translate,
  ),
  "思考中 4s · 正在推导方案",
);
assert.equal(
  buildThinkingSummaryLabel(
    { kind: "thinking", text: "正在推导方案", startTs: 1000, ts: 1400 },
    true,
    translate,
  ),
  "思考中 · 正在推导方案",
);

const notice = {
  kind: "notice",
  code: "apiRetry",
  level: "warning",
  detail: "retrying request",
};
const progressNotice = {
  kind: "notice",
  code: "shellLongRunning",
  level: "progress",
  detail: "python3 report.py",
};
const liveTurn = {
  phase: "streaming",
  thinkingText: "",
  startedAt: 1_000,
  updatedAt: 1_000,
  tools: new Map(),
  timeline: [notice, progressNotice],
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

assert.equal(timelineForView(liveTurn, false).length, 1, "live keeps progress notices only");
assert.equal(timelineForView(sealedTurn, true).length, 1, "sealed keeps notices");

const now = 16_000;
// The live status line tells the user the turn is interruptible, and shows
// token spend as soon as usage telemetry arrives.
assert.equal(
  buildLiveStatusText({ ...liveTurn, thinkingText: "planning" }, translate, now),
  "15s · 思考中 · Esc 停止",
);
assert.equal(
  buildLiveStatusText({ ...liveTurn, activityLabel: '- "If the' }, translate, now),
  "15s · 等待回复 · Esc 停止",
);
assert.equal(
  buildLiveStatusText(
    { ...liveTurn, thinkingText: "planning", usage: { estimatedTokens: 1200 } },
    translate,
    now,
  ),
  "15s · 思考中 · 1.2k tokens · Esc 停止",
);
// Tool input can be long, partial, or noisy. The top status stays stable; the
// detailed command belongs in the process timeline row.
assert.equal(
  buildLiveStatusText(
    { ...liveTurn, tools: new Map([["t1", { name: "bash", status: "running", input: { command: "git log --oneline | head" } }]]) },
    translate,
    now,
  ),
  "15s · 运行命令… · Esc 停止",
);

assert.equal(
  buildStatusText({ phase: "awaiting_user" }, {}, translate, now),
  "等待你确认",
);

// The user pressed stop — the status line must say so instead of looking
// like a frozen "thinking" state.
assert.equal(
  buildStatusText({ phase: "stopping" }, {}, translate, now),
  "正在停止…",
);

assert.equal(
  buildStatusText(sealedTurn, { sealed: true }, translate, now),
  "耗时 8s · 1.2k tokens",
);

assert.equal(
  buildStatusFooterText(sealedTurn, translate),
  "耗时 8s · 1.2k tokens",
);

assert.equal(
  taskRunSummaryForView(
    { status: "completed", evidence: [{}, {}], risks: [{}], verification: { status: "verified" } },
    translate,
  ),
  "completed/2/1/verified",
);

assert.equal(
  taskRunSummaryForView(
    {
      status: "completed",
      evidence: [{}],
      risks: [{ code: "NO_VISIBLE_PROGRESS", status: "resolved" }, { code: "ENGINE_WARNING", status: "active" }],
      verification: { status: "observed" },
    },
    translate,
  ),
  "completed/1/1/observed",
);

console.log("turn-view-renderer: ok");
