import { getRenderableTimeline, resolveActivityLabel } from "./turn-timeline.js";
import { toolRowPreview } from "./turn-process-layout.js";
import { formatTokenCount, summarizeTurnUsage } from "./turn-usage-summary.js";

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

// Accepts a thinking timeline entry; a plain string still works for callers
// that only have text (no duration shown in that case).
export function buildThinkingSummaryLabel(entry, live, translate) {
  const block = typeof entry === "string" ? { text: entry } : entry || {};
  if (!live) {
    const seconds = thinkingDurationSeconds(block);
    if (seconds >= 1) return translate("turn.thinking.doneSummary", { seconds });
    return translate("turn.thinking.title");
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
  return timeline.filter((entry) => entry.kind !== "notice");
}

export function liveElapsedSeconds(liveTurn, now = Date.now()) {
  const start = Number(liveTurn.startedAt) || Number(liveTurn.updatedAt) || now;
  return Math.max(0, Math.floor((now - start) / 1000));
}

export function resolveLiveStatusActivity(liveTurn, translate) {
  const explicit = resolveActivityLabel(liveTurn);
  if (explicit) return explicit;

  if ((liveTurn.thinkingText || "").trim()) return translate("turn.status.thinking");

  const timeline = getRenderableTimeline(liveTurn);
  const doneTools = timeline.filter((entry) => entry.kind === "tool" && entry.status === "done");
  const lastDone = doneTools[doneTools.length - 1];
  if (lastDone) return toolRowPreview(lastDone);

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
