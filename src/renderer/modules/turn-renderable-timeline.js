import { t } from "../i18n/index.js";
import { isTokenCountDetail } from "./turn-activity-policy.js";
import { buildTimelineFromLegacy } from "./turn-legacy-timeline.js";
import { answerBlockIndex, hasVisibleText } from "../../shared/timeline-blocks.mjs";

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
  // The answer block renders as the answer bubble; earlier text blocks stay
  // in the timeline so prose written between tools keeps its place.
  const answerIndex = answerBlockIndex(timeline);
  return timeline.filter((entry, index) => {
    if (entry.kind === "text") {
      return index !== answerIndex && hasVisibleText(entry.text);
    }
    if (entry.kind !== "notice") return true;
    if (entry.code === "thinkingProgress") return false;
    if (isTokenCountDetail(entry.detail)) return false;
    return Boolean(resolveNoticeDetail(entry));
  });
}

export function getRenderableTimeline(liveTurn = {}) {
  if (liveTurn.timeline?.length) return filterRenderableTimeline(liveTurn.timeline);
  return filterRenderableTimeline(buildTimelineFromLegacy(liveTurn));
}
