import { getRenderableTimeline } from "./turn-renderable-timeline.js";
import { formatTokenCount, summarizeTurnUsage } from "./turn-usage-summary.js";

// The live status line shows a STABLE activity by tool TYPE — not the streaming
// tool arguments. Piping the raw preview (e.g. a half-streamed command/query)
// made the status flicker out meaningless fragments char-by-char ("Maybe", stray
// symbols). The detailed args still live in the timeline rows. Matches the
// official OpenCode clients, which show a plain spinner + "Working…".
const TOOL_STATUS_KEY = {
  bash: "turn.status.tool.bash",
  read: "turn.status.tool.read",
  write: "turn.status.tool.edit",
  edit: "turn.status.tool.edit",
  multiedit: "turn.status.tool.edit",
  patch: "turn.status.tool.edit",
  apply_patch: "turn.status.tool.edit",
  notebookedit: "turn.status.tool.edit",
  glob: "turn.status.tool.search",
  grep: "turn.status.tool.search",
  list: "turn.status.tool.search",
  ls: "turn.status.tool.search",
  webfetch: "turn.status.tool.web",
  websearch: "turn.status.tool.web",
  task: "turn.status.tool.task",
};

function runningToolStatusLabel(liveTurn, translate) {
  const tools = liveTurn.tools;
  if (!tools) return null;
  const values = tools instanceof Map ? tools.values() : tools;
  for (const tool of values) {
    if (tool?.status !== "running") continue;
    const name = String(tool.name || "").toLowerCase();
    return translate(TOOL_STATUS_KEY[name] || "turn.status.tool.generic");
  }
  return null;
}

export const THINKING_SUMMARY_MAX = 72;

export function thinkingSummaryPreview(text = "", max = THINKING_SUMMARY_MAX) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `…${normalized.slice(-(max - 1))}`;
}

function thinkingDurationSeconds(block) {
  const start = Number(block.startTs);
  const end = Number(block.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 1000);
}

function thinkingDurationMs(block) {
  const start = Number(block.startTs);
  const end = Number(block.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return end - start;
}

export function renderableThinkingEntries(entries = []) {
  return entries.filter((entry) => entry?.kind === "thinking" && String(entry.text || "").trim());
}

export function shouldGroupFinishedThinking(entries = [], sealed = false) {
  return sealed && renderableThinkingEntries(entries).length >= 2;
}

export function buildThinkingGroupSummary(entries = [], translate) {
  const renderable = renderableThinkingEntries(entries);
  const seconds = Math.round(renderable.reduce((sum, entry) => sum + thinkingDurationMs(entry), 0) / 1000);
  if (seconds >= 1) {
    return translate("timeline.thinkingGroupTimed", { count: renderable.length, seconds });
  }
  return translate("timeline.thinkingGroup", { count: renderable.length });
}

export function progressPercent(progress = null) {
  if (!progress || typeof progress !== "object") return null;
  const explicit = Number(progress.percent ?? progress.value);
  const current = Number(progress.current ?? progress.done ?? progress.writtenBytes ?? progress.currentBytes);
  const total = Number(progress.total ?? progress.max ?? progress.totalBytes);
  const hasRange = Number.isFinite(current) && Number.isFinite(total) && total > 0;
  if (Number.isFinite(explicit)) {
    if (explicit <= 0 && !hasRange) return null;
    return Math.max(0, Math.min(100, explicit));
  }
  if (hasRange) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

export function buildToolDurationSuffix(entry = {}, now = Date.now()) {
  if (!["done", "failed", "running"].includes(entry.status)) return "";
  const start = Number(entry.startTs);
  const end = entry.status === "running" ? Number(now) : Number(entry.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 100) return "";
  return ` · ${((end - start) / 1000).toFixed(1)}s`;
}

export function buildToolStatusLabel(toolOrStatus, translate) {
  const status = typeof toolOrStatus === "string"
    ? toolOrStatus
    : (toolOrStatus?.status || "done");
  const name = typeof toolOrStatus === "string"
    ? ""
    : String(toolOrStatus?.name || "").toLowerCase();
  if (status === "failed") return translate("tool.status.failed");
  if (status === "running") return translate("tool.status.running");
  if (name === "bash") return translate("tool.status.commandDone");
  return translate("tool.status.done");
}

const PERMISSION_KIND_KEYS = {
  bash: "permission.kind.bash",
  edit: "permission.kind.edit",
  write: "permission.kind.write",
  read: "permission.kind.read",
  webfetch: "permission.kind.webfetch",
  websearch: "permission.kind.websearch",
  external_directory: "permission.kind.externalDirectory",
};

export function permissionLabelForView(item = {}, translate) {
  const key = String(item.toolName || "").trim();
  const i18nKey = PERMISSION_KIND_KEYS[key];
  const prefix = item.subagent?.sessionId ? `${translate("subagent.promptPrefix")} · ` : "";
  if (i18nKey) {
    const label = translate(i18nKey);
    if (label !== i18nKey) return prefix + (item.title ? `${label}（${item.title}）` : label);
  }
  return prefix + (item.title || key || translate("turn.permission.toolFallback"));
}

export function subagentDescriptionForView(entry = {}, translate) {
  const input = entry.input || {};
  return String(input.description || entry.title || input.prompt || translate("tool.subagentTask")).trim();
}

export function subagentLabelForView(entry = {}, translate) {
  const type = String(entry.input?.subagent_type || entry.input?.subagentType || "").trim();
  return type ? `${type[0].toUpperCase()}${type.slice(1)}` : translate("tool.subagent");
}

export function subagentMetadataLineForView(entry = {}, translate) {
  const meta = entry.metadata || {};
  const sub = entry.subagent || {};
  const bits = [];
  const sessionId = meta.sessionId || meta.sessionID || sub.sessionId;
  if (sessionId) bits.push(translate("subagent.session", { id: sessionId }));
  const toolCalls = meta.toolcalls ?? meta.toolCalls ?? meta.calls ?? sub.tools?.length;
  if (Number.isFinite(Number(toolCalls)) && Number(toolCalls) > 0) {
    bits.push(translate("subagent.toolCalls", { count: Number(toolCalls) }));
  }
  const pending = (sub.pendingPermissions?.length || 0) + (sub.pendingQuestions?.length || 0);
  if (pending > 0) bits.push(translate("subagent.waitingForUser", { count: pending }));
  const model = meta.model?.modelID || meta.model?.modelId || meta.model;
  if (typeof model === "string" && model) bits.push(translate("subagent.model", { model }));
  return bits.join(" · ");
}

export function subagentPhaseLabelForView(sub = {}, fallbackStatus = "", translate) {
  const phase = String(sub.phase || "");
  if (phase) {
    const key = `subagent.phase.${phase}`;
    const label = translate(key);
    if (label !== key) return label;
  }
  const status = String(fallbackStatus || "");
  if (status === "running") return translate("subagent.status.running");
  if (status === "failed") return translate("subagent.status.failed");
  if (status === "done" || status === "completed") return translate("subagent.status.done");
  return translate("subagent.status.pending");
}

export function subagentStatusTextForView(entry = {}, translate) {
  const sub = entry.subagent || {};
  if ((sub.pendingPermissions?.length || 0) + (sub.pendingQuestions?.length || 0) > 0) {
    return translate("subagent.status.awaitingUser");
  }
  return subagentPhaseLabelForView(sub, entry.status, translate);
}

export function subagentCurrentToolForView(entry = {}) {
  const sub = entry.subagent || {};
  const tools = Array.isArray(sub.tools) ? sub.tools : [];
  return tools.find((tool) => tool.id === sub.currentToolId) || tools.at(-1) || null;
}

export function subagentPanelOpenForView(entries = [], sealed = false) {
  return !sealed && entries.some((entry) => entry.status === "running" || entry.status === "failed");
}

export function subagentPanelSummaryForView(entries = [], translate) {
  const running = entries.filter((entry) => entry.status === "running").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  if (failed) return translate("subagent.summaryFailed", { failed, total: entries.length });
  if (running) return translate("subagent.summaryRunning", { running, total: entries.length });
  return translate("subagent.summaryDone", { total: entries.length });
}

export function subagentTranscriptTextForView(sub = {}, translate) {
  const parts = [];
  const text = String(sub.textFull || "").trim();
  if (text) parts.push(`${translate("subagent.transcriptOutput")}\n${text}`);
  return parts.join("\n\n").trim();
}

export function subagentStatsLineForView(entry = {}, translate) {
  const stats = entry.subagent?.stats || {};
  const bits = [];
  if (Number(stats.runningTools || 0) > 0) {
    bits.push(translate("subagent.stats.runningTools", { count: Number(stats.runningTools || 0) }));
  }
  if (Number(stats.doneTools || 0) > 0) {
    bits.push(translate("subagent.stats.doneTools", { count: Number(stats.doneTools || 0) }));
  }
  if (Number(stats.nestedTasks || 0) > 0) {
    bits.push(translate("subagent.stats.nestedTasks", { count: Number(stats.nestedTasks || 0) }));
  }
  return bits.join(" · ");
}

// Accepts a thinking timeline entry; a plain string still works for callers
// that only have text (no duration shown in that case).
export function buildThinkingSummaryLabel(entry, live, translate) {
  const block = typeof entry === "string" ? { text: entry } : entry || {};
  if (!live) {
    const seconds = thinkingDurationSeconds(block);
    if (seconds >= 1) return translate("turn.thinking.doneSummary", { seconds });
    return translate("turn.thinking.doneTitle");
  }
  const preview = thinkingSummaryPreview(block.text);
  if (!preview) return translate("turn.thinking.title");
  const seconds = thinkingDurationSeconds(block);
  if (seconds >= 1) return translate("turn.thinking.liveSummaryTimed", { seconds, preview });
  return translate("turn.thinking.liveSummary", { preview });
}

export function timelineForView(liveTurn, sealed = false) {
  const timeline = getRenderableTimeline(liveTurn).filter((entry) => entry.kind !== "status");
  if (sealed) return timeline;
  return timeline.filter((entry) => entry.kind !== "notice" || entry.level === "progress");
}

export function liveElapsedSeconds(liveTurn, now = Date.now()) {
  const start = Number(liveTurn.startedAt) || Number(liveTurn.updatedAt) || now;
  return Math.max(0, Math.floor((now - start) / 1000));
}

export function resolveLiveStatusActivity(liveTurn, translate) {
  // A running tool → a stable verb for its TYPE (no streaming args).
  const running = runningToolStatusLabel(liveTurn, translate);
  if (running) return running;

  if ((liveTurn.thinkingText || "").trim()) return translate("turn.status.thinking");

  if (liveTurn.phase === "starting") return translate("turn.status.starting");
  if (liveTurn.phase === "streaming") return translate("turn.status.waiting");
  return translate("turn.status.working");
}

export function buildLiveStatusText(liveTurn, translate, now = Date.now()) {
  const activity = resolveLiveStatusActivity(liveTurn, translate);
  const seconds = liveElapsedSeconds(liveTurn, now);
  if (seconds < 1) return activity;
  const parts = [translate("turn.status.live", { seconds, activity })];
  const usage = resolveTurnUsage(liveTurn);
  if (usage?.total > 0) {
    parts.push(translate("turn.footer.tokens", { count: formatTokenCount(usage.total) }));
  }
  parts.push(translate("turn.status.escHint"));
  return parts.join(" · ");
}

function resolveTurnUsage(liveTurn) {
  const raw = liveTurn.usage ??
    liveTurn.final?.payload?.record?.usage ??
    liveTurn.final?.payload?.usage ??
    null;
  return summarizeTurnUsage(raw);
}

export function buildStatusFooterText(liveTurn, translate) {
  const durationMs = liveTurn.durationMs ??
    (liveTurn.final?.payload?.durationMs ?? liveTurn.final?.payload?.record?.durationMs);
  const usage = resolveTurnUsage(liveTurn);
  const parts = [];
  if (Number.isFinite(durationMs) && durationMs > 0) {
    const sec = Math.max(1, Math.round(durationMs / 1000));
    parts.push(translate("turn.footer.duration", { seconds: sec }));
  }
  if (usage?.total > 0) {
    if (usage.input > 0 && usage.output > 0) {
      parts.push(translate("turn.footer.tokensDetail", {
        input: formatTokenCount(usage.input),
        output: formatTokenCount(usage.output),
      }));
    } else {
      parts.push(translate("turn.footer.tokens", { count: formatTokenCount(usage.total) }));
    }
  }
  return parts.join(" · ");
}

export function buildStatusText(liveTurn, { failed = false, sealed = false } = {}, translate, now = Date.now()) {
  if (liveTurn.final) {
    if (failed || liveTurn.final.type === "turn.failed") return translate("turn.status.failed");
    if (liveTurn.final.type === "turn.interrupted") return translate("turn.status.interrupted");
    if (liveTurn.final.type === "turn.stalled") return translate("turn.status.stalled");
    if (sealed) return buildStatusFooterText(liveTurn, translate);
    return "";
  }
  if (liveTurn.phase === "stopping") return translate("turn.status.stopping");
  if (liveTurn.phase === "awaiting_user") return translate("turn.status.awaitingUser");
  return buildLiveStatusText(liveTurn, translate, now);
}

export function taskRunSummaryForView(taskRun, translate) {
  if (!taskRun || typeof taskRun !== "object") return "";
  const evidence = Array.isArray(taskRun.evidence) ? taskRun.evidence.length : 0;
  const risks = Array.isArray(taskRun.risks)
    ? taskRun.risks.filter((risk) => risk?.status !== "resolved").length
    : 0;
  const verification = taskRun.verification?.status || "";
  return translate("task.summary.compact", {
    status: taskRun.status || "completed",
    evidence,
    risks,
    verification,
  });
}
