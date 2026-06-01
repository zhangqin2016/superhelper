/**
 * Engine activity lines in the assistant turn panel (CLI compaction, retries, etc.).
 */
import { t } from "../i18n/index.js";

/**
 * @param {Record<string, unknown>} payload
 */
export function engineNoticeText(payload) {
  if (!payload?.code) return payload?.message || payload?.detail || "";
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? ` · ${payload.model.trim()}`
      : "";
  const params = {
    model,
    attempt: payload.attempt || 1,
    maxRetries: payload.maxRetries || "…",
    detail: payload.detail || payload.message || "",
    subtype: payload.subtype || "",
    type: payload.type || "",
  };
  const key = `engine.${payload.code}`;
  const translated = t(key, params);
  if (translated !== key) return translated;
  if (payload.detail) return String(payload.detail);
  if (payload.message) return String(payload.message);
  return t("engine.fallback");
}

/**
 * @param {import("./message.js").SessionView} viewState
 * @param {Record<string, unknown>} payload
 */
export function addOrUpdateEngineNotice(viewState, payload) {
  if (!viewState.activeTurn?.activity || payload?.panel === false) return;

  const activity = viewState.activeTurn.activity;
  activity.hidden = false;

  if (!viewState.engineNotices) {
    viewState.engineNotices = new Map();
  }

  const code = String(payload.code || "generic");
  const replace = Boolean(payload.replace);
  const id = replace ? `engine:${code}` : `engine:${code}:${Date.now()}`;
  const text = engineNoticeText(payload);
  const done = Boolean(payload.done);
  const level = payload.level === "warning" ? "failed" : done ? "done" : "running";

  let entry = viewState.engineNotices.get(id);
  if (entry?.card?.isConnected) {
    entry.card.classList.remove("tool-card-running", "tool-card-done", "tool-card-failed");
    entry.card.classList.add(level === "failed" ? "tool-card-failed" : level === "done" ? "tool-card-done" : "tool-card-running");
    const label = entry.card.querySelector(".tool-card-label");
    if (label) label.textContent = text;
    const dot = entry.card.querySelector(".tool-card-dot");
    if (dot && level === "done") dot.classList.add("tool-card-dot-done");
    entry.status = level;
    return;
  }

  if (replace) {
    const replacesCode = typeof payload.replacesCode === "string" ? payload.replacesCode : null;
    for (const [key, item] of viewState.engineNotices) {
      if (key.startsWith(`engine:${code}`) || (replacesCode && key.startsWith(`engine:${replacesCode}`))) {
        item.card?.remove();
        viewState.engineNotices.delete(key);
      }
    }
  }

  const card = document.createElement("div");
  card.className = `tool-card engine-notice-card ${
    level === "failed"
      ? "tool-card-failed"
      : level === "done"
        ? "tool-card-done"
        : "tool-card-running"
  }`;
  card.dataset.engineCode = code;

  const dot = document.createElement("span");
  dot.className = "tool-card-dot";
  if (level === "done") dot.classList.add("tool-card-dot-done");

  const label = document.createElement("span");
  label.className = "tool-card-label";
  label.textContent = text;

  card.append(dot, label);
  activity.appendChild(card);
  viewState.engineNotices.set(id, { card, code, status: level });
}

export function clearEngineNotices(viewState) {
  if (!viewState.engineNotices) return;
  for (const { card } of viewState.engineNotices.values()) {
    card?.remove();
  }
  viewState.engineNotices.clear();
}
