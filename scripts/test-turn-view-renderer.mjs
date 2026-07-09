#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  THINKING_SUMMARY_MAX,
  thinkingSummaryPreview,
  buildThinkingSummaryLabel,
  buildThinkingGroupSummary,
  buildToolDurationSuffix,
  buildToolStatusLabel,
  permissionLabelForView,
  progressPercent,
  renderableThinkingEntries,
  shouldGroupFinishedThinking,
  subagentDescriptionForView,
  subagentCurrentToolForView,
  subagentLabelForView,
  subagentMetadataLineForView,
  subagentPanelSummaryForView,
  subagentPanelOpenForView,
  subagentPhaseLabelForView,
  subagentStatsLineForView,
  subagentStatusTextForView,
  subagentTranscriptTextForView,
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
    "tool.status.failed": "失败",
    "tool.status.running": "运行中",
    "tool.status.commandDone": "命令完成",
    "tool.status.done": "完成",
    "turn.footer.duration": `耗时 ${params.seconds}s`,
    "turn.footer.tokens": `${params.count} tokens`,
    "turn.footer.tokensDetail": `输入 ${params.input} · 输出 ${params.output} tokens`,
    "permission.kind.bash": "运行命令",
    "permission.kind.externalDirectory": "访问工作区以外的目录",
    "subagent.promptPrefix": "子代理",
    "subagent.session": `会话 ${params.id}`,
    "subagent.toolCalls": `${params.count} 次工具`,
    "subagent.waitingForUser": `等待 ${params.count} 个确认`,
    "subagent.model": `模型 ${params.model}`,
    "subagent.phase.running": "执行中",
    "subagent.status.awaitingUser": "等待你确认",
    "subagent.status.running": "运行中",
    "subagent.status.failed": "失败",
    "subagent.status.done": "完成",
    "subagent.status.pending": "等待中",
    "subagent.stats.runningTools": `${params.count} 个运行中`,
    "subagent.stats.doneTools": `${params.count} 个已完成`,
    "subagent.stats.nestedTasks": `${params.count} 个子任务`,
    "subagent.summaryFailed": `${params.failed}/${params.total} 失败`,
    "subagent.summaryRunning": `${params.running}/${params.total} 运行`,
    "subagent.summaryDone": `${params.total} 完成`,
    "subagent.transcriptOutput": "输出",
    "tool.subagent": "子代理",
    "tool.subagentTask": "子任务",
    "turn.permission.toolFallback": "工具调用",
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
const thinkingEntries = [
  { kind: "thinking", text: " first ", startTs: 1000, ts: 2200 },
  { kind: "tool", text: "ignored", startTs: 1000, ts: 9000 },
  { kind: "thinking", text: "second", startTs: 3000, ts: 4300 },
  { kind: "thinking", text: "   ", startTs: 5000, ts: 7000 },
];
assert.equal(renderableThinkingEntries(thinkingEntries).length, 2);
assert.equal(shouldGroupFinishedThinking(thinkingEntries, false), false);
assert.equal(shouldGroupFinishedThinking(thinkingEntries, true), true);
assert.equal(
  buildThinkingGroupSummary(thinkingEntries, translate),
  "timeline.thinkingGroupTimed",
  "thinking group summaries should be computed outside the DOM renderer",
);
assert.equal(progressPercent({ percent: 42 }), 42);
assert.equal(progressPercent({ current: 2, total: 4 }), 50);
assert.equal(progressPercent({ currentBytes: 1, totalBytes: 3 }), 33.33333333333333);
assert.equal(progressPercent({ current: 12, total: 10 }), 100);
assert.equal(progressPercent({ current: -1, total: 10 }), 0);
assert.equal(progressPercent({ percent: 0 }), null);
assert.equal(progressPercent(null), null);
assert.equal(
  buildToolDurationSuffix({ status: "done", startTs: 1000, ts: 2600 }),
  " · 1.6s",
);
assert.equal(buildToolDurationSuffix({ status: "failed", startTs: 1000, ts: 1200 }), " · 0.2s");
assert.equal(buildToolDurationSuffix({ status: "running", startTs: 1000 }, 2600), " · 1.6s");
assert.equal(buildToolDurationSuffix({ status: "done", startTs: 1000, ts: 1050 }), "");
assert.equal(buildToolStatusLabel({ status: "failed", name: "bash" }, translate), "失败");
assert.equal(buildToolStatusLabel({ status: "running", name: "read" }, translate), "运行中");
assert.equal(buildToolStatusLabel({ status: "done", name: "bash" }, translate), "命令完成");
assert.equal(buildToolStatusLabel({ status: "done", name: "read" }, translate), "完成");
assert.equal(buildToolStatusLabel("running", translate), "运行中");
assert.equal(
  permissionLabelForView({ toolName: "bash", title: "npm test" }, translate),
  "运行命令（npm test）",
);
assert.equal(
  permissionLabelForView({ toolName: "external_directory", subagent: { sessionId: "sub_1" } }, translate),
  "子代理 · 访问工作区以外的目录",
);
assert.equal(
  permissionLabelForView({ title: "Custom permission" }, translate),
  "Custom permission",
);
const subagentEntry = {
  status: "running",
  title: "Inspect renderer",
  input: { subagent_type: "reviewer" },
  metadata: { sessionId: "sub_1", toolCalls: 3, model: { modelID: "gpt-5" } },
  subagent: {
    sessionId: "sub_1",
    phase: "running",
    pendingPermissions: [{}],
    pendingQuestions: [{}],
    stats: { runningTools: 1, doneTools: 2, nestedTasks: 1 },
  },
};
assert.equal(subagentDescriptionForView(subagentEntry, translate), "Inspect renderer");
assert.equal(subagentLabelForView(subagentEntry, translate), "Reviewer");
assert.equal(
  subagentMetadataLineForView(subagentEntry, translate),
  "会话 sub_1 · 3 次工具 · 等待 2 个确认 · 模型 gpt-5",
);
assert.equal(subagentPhaseLabelForView(subagentEntry.subagent, "running", translate), "执行中");
assert.equal(subagentStatusTextForView(subagentEntry, translate), "等待你确认");
assert.equal(subagentStatsLineForView(subagentEntry, translate), "1 个运行中 · 2 个已完成 · 1 个子任务");
assert.equal(
  subagentCurrentToolForView({ subagent: { currentToolId: "tool_1", tools: [{ id: "tool_1", name: "Read" }, { id: "tool_2", name: "Bash" }] } }).name,
  "Read",
);
assert.equal(
  subagentCurrentToolForView({ subagent: { tools: [{ id: "tool_1", name: "Read" }, { id: "tool_2", name: "Bash" }] } }).name,
  "Bash",
);
assert.equal(subagentCurrentToolForView({ subagent: { tools: [] } }), null);
assert.equal(
  subagentPanelSummaryForView([{ status: "running" }, { status: "done" }], translate),
  "1/2 运行",
);
assert.equal(
  subagentPanelSummaryForView([{ status: "failed" }, { status: "running" }], translate),
  "1/2 失败",
);
assert.equal(subagentPanelSummaryForView([{ status: "done" }], translate), "1 完成");
assert.equal(subagentPanelOpenForView([{ status: "running" }], false), true);
assert.equal(subagentPanelOpenForView([{ status: "failed" }], false), true);
assert.equal(subagentPanelOpenForView([{ status: "running" }], true), false);
assert.equal(subagentTranscriptTextForView({ textFull: "hello\nworld" }, translate), "输出\nhello\nworld");
assert.equal(subagentTranscriptTextForView({ textFull: "   " }, translate), "");
assert.equal(subagentLabelForView({ input: {} }, translate), "子代理");
assert.equal(subagentDescriptionForView({ input: {} }, translate), "子任务");

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
  buildLiveStatusText({
    ...liveTurn,
    livenessNotice: {
      code: "toolProgress",
      detail: "write 正在运行 · 已运行 33s · 最近活动 33s 前",
    },
  }, translate, now),
  "15s · write 正在运行 · 已运行 33s · 最近活动 33s 前 · Esc 停止",
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
