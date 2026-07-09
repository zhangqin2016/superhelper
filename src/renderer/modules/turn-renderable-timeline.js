import { t } from "../i18n/index.js";
import { isTokenCountDetail } from "./turn-activity-policy.js";
import { buildTimelineFromLegacy } from "./turn-legacy-timeline.js";

const LIVENESS_NOTICE_CODES = new Set(["longWait", "toolProgress"]);

export function resolveNoticeDetail(entry = {}) {
  const detail = String(entry.detail || "").trim();
  if (entry.code === "turnSteered") {
    const label = t("message.steerBadge");
    return detail ? `${label}: ${detail}` : label;
  }
  if (detail) return detail;
  const code = String(entry.code || "").trim();
  if (!code) return "";
  const key = `engine.${code}`;
  const translated = t(key);
  return translated === key ? "" : translated;
}

function filterRenderableTimeline(timeline = []) {
  // The newest text block renders as the answer bubble; earlier text blocks
  // stay in the timeline so prose written between tools keeps its place.
  let lastTextIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "text") {
      lastTextIndex = index;
      break;
    }
  }
  return timeline.filter((entry, index) => {
    if (entry.kind === "text") {
      return index !== lastTextIndex && Boolean(String(entry.text || "").trim());
    }
    if (entry.kind !== "notice") return true;
    if (LIVENESS_NOTICE_CODES.has(entry.code)) return false;
    if (entry.code === "thinkingProgress") return false;
    if (isTokenCountDetail(entry.detail)) return false;
    return Boolean(resolveNoticeDetail(entry));
  });
}

export function getRenderableTimeline(liveTurn = {}) {
  if (liveTurn.timeline?.length) return filterRenderableTimeline(liveTurn.timeline);
  return filterRenderableTimeline(buildTimelineFromLegacy(liveTurn));
}
