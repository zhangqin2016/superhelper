import { isTokenCountDetail } from "./turn-activity-policy.js";

function ensureTimeline(target) {
  if (!Array.isArray(target.timeline)) target.timeline = [];
  return target.timeline;
}

export function appendTimelineNotice(target, notice, ts = Date.now()) {
  if (!notice || notice.panel === false) return;
  if (notice.code === "thinkingProgress" || isTokenCountDetail(notice.detail)) return;
  const timeline = ensureTimeline(target);
  const entry = {
    kind: "notice",
    ts,
    code: notice.code || "",
    level: notice.level || "info",
    detail: notice.detail || notice.message || "",
    progress: notice.progress && typeof notice.progress === "object" ? notice.progress : null,
    done: Boolean(notice.done),
    replace: Boolean(notice.replace),
    replacesCode: notice.replacesCode || "",
  };
  if (notice.replace) {
    const replaceCode = String(notice.replacesCode || notice.code || "");
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const existing = timeline[index];
      if (existing?.kind !== "notice") continue;
      const existingCode = String(existing.code || "");
      const existingReplaceCode = String(existing.replacesCode || "");
      if (
        existingCode === replaceCode ||
        existingCode === entry.code ||
        existingReplaceCode === replaceCode
      ) {
        timeline[index] = { ...existing, ...entry };
        return;
      }
    }
  }
  timeline.push(entry);
}
