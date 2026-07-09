import { resolveNoticeDetail } from "./turn-renderable-timeline.js";
import { progressPercent } from "./turn-view-status.js";

export function renderNoticeEntry(entry, {
  resolveDetail = resolveNoticeDetail,
  resolveProgressPercent = progressPercent,
} = {}) {
  const detail = resolveDetail(entry);
  if (!detail) return null;
  const row = document.createElement("div");
  row.className = `assistant-process-notice is-${entry.level || "info"}`;
  if (entry.code === "toolProgress" || entry.code === "longWait") {
    row.classList.add("is-liveness");
  }
  const percent = resolveProgressPercent(entry.progress);
  if (entry.progress && typeof entry.progress === "object") {
    const text = document.createElement("div");
    text.className = "assistant-process-notice-text";
    text.textContent = detail;
    row.appendChild(text);
    if (percent != null) {
      row.classList.add("is-progress");
      const track = document.createElement("div");
      track.className = "assistant-process-progress-track";
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(Math.round(percent)));
      const fill = document.createElement("div");
      fill.className = "assistant-process-progress-fill";
      fill.style.width = `${percent}%`;
      track.appendChild(fill);
      row.appendChild(track);
    }
    return row;
  }
  row.textContent = detail;
  return row;
}
