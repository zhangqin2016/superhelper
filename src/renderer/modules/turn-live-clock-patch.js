import { t } from "../i18n/index.js";
import { buildToolDurationSuffix, buildToolStatusLabel } from "./turn-view-status.js";

/**
 * Per-second clock tick for RUNNING tool rows: a surgical text update on each
 * row's `.assistant-tool-status`, NOT a full article re-render. The visual
 * signature deliberately excludes elapsed time so heartbeats never force
 * morphdom over the whole timeline (see message-live-render-model.js);
 * appearance/disappearance of rows still rides normal event-driven renders.
 * Returns the number of rows updated (0 when nothing is running).
 */
export function patchLiveToolClocks(article, liveTurn, { now = Date.now(), translate = t } = {}) {
  if (!article?.querySelectorAll || !liveTurn) return 0;
  const running = new Map();
  for (const entry of liveTurn.timeline || []) {
    if (entry?.kind === "tool" && entry.status === "running" && entry.id) {
      running.set(String(entry.id), entry);
    }
  }
  if (!running.size) return 0;
  let patched = 0;
  for (const row of article.querySelectorAll(".assistant-tool-row")) {
    const entry = running.get(String(row.dataset?.toolId || ""));
    if (!entry) continue;
    const status = row.querySelector?.(".assistant-tool-status");
    if (!status) continue;
    const text = buildToolStatusLabel(entry, translate) + buildToolDurationSuffix(entry, now, translate);
    if (status.textContent !== text) {
      status.textContent = text;
      patched += 1;
    }
  }
  return patched;
}
