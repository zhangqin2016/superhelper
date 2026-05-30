/**
 * Tool card rendering — displayed during assistant tool execution.
 */
import { $, scrollToBottom } from "./dom.js";
import store from "./state.js";
import { t } from "../i18n/index.js";

function basename(path) {
  if (!path) return "";
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || String(path);
}

function clip(text, max = 72) {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function toolSummary(name, input = {}) {
  switch (name) {
    case "Read":
      return { title: t("tool.readFile"), detail: basename(input.file_path || input.path || input.target_file) };
    case "Write":
      return { title: t("tool.writeFile"), detail: basename(input.file_path || input.path) };
    case "Edit":
    case "MultiEdit":
      return { title: t("tool.editFile"), detail: basename(input.file_path || input.path) };
    case "Bash":
      return { title: t("tool.runCommand"), detail: clip(input.command || input.description) };
    case "Grep":
      return { title: t("tool.searchContent"), detail: clip(input.pattern || input.query) };
    case "Glob":
      return { title: t("tool.findFiles"), detail: clip(input.pattern || input.glob_pattern) };
    case "WebSearch":
    case "web_search_prime":
      return { title: t("tool.webSearch"), detail: clip(input.query || input.search_query) };
    case "webReader":
      return { title: t("tool.readWeb"), detail: clip(input.url) };
    case "Task":
      return {
        title: t("tool.subagentTask"),
        detail: clip(input.description || input.prompt || input.task),
      };
    case "Agent":
    case "Subagent":
      return {
        title: t("tool.subagent"),
        detail: clip(input.description || input.prompt),
      };
    default:
      return {
        title: name || t("tool.processing"),
        detail: clip(input.query || input.prompt || input.description || input.file_path || input.path),
      };
  }
}

function renderToolCardContent(card, name, input) {
  const { title, detail } = toolSummary(name, input);
  card.replaceChildren();

  const dot = document.createElement("span");
  dot.className = "tool-card-dot";

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  textWrap.style.flex = "1";

  const label = document.createElement("span");
  label.className = "tool-card-label";
  label.textContent = title;

  textWrap.appendChild(label);
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "tool-card-detail";
    detailEl.textContent = detail;
    textWrap.appendChild(detailEl);
  }

  card.append(dot, textWrap);
}

export function countRunningTools(toolCards) {
  let n = 0;
  for (const entry of toolCards.values()) {
    if (entry.status === "running") n++;
  }
  return n;
}

export function addToolCard(viewState, id, name, input) {
  if (!viewState.activeTurn) return;

  const summary = toolSummary(name, input);
  viewState.activityLabel = summary.detail
    ? `${summary.title}：${summary.detail}`
    : summary.title;

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;
  renderToolCardContent(card, name, input);

  viewState.activeTurn.activity.appendChild(card);
  viewState.activeTurn.activity.hidden = false;
  scrollToBottom(false, viewState.panel);
  viewState.toolCards.set(id, { card, name, input, status: "running" });
}

export function updateToolCard(viewState, id, status) {
  const entry = viewState.toolCards.get(id);
  if (!entry) return;

  if (status === "failed") {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-failed");
    entry.card.querySelector(".tool-card-label").textContent =
      t("message.toolFailed", { title: toolSummary(entry.name, entry.input).title });
    entry.status = "failed";
    viewState.toolCards.delete(id);
    viewState.activityLabel = t("message.adjusting");
    updateBusyMeta(viewState);
    window.setTimeout(() => {
      entry.card.remove();
      syncActivityVisibility(viewState);
      syncTurnProgress(viewState);
      refreshRunningActivityLabel(viewState);
    }, 4000);
  } else {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-done");
    entry.card.querySelector(".tool-card-dot")?.classList.add("tool-card-dot-done");
    entry.status = "done";
    refreshRunningActivityLabel(viewState);
  }

  syncTurnProgress(viewState);
  syncActivityVisibility(viewState);
}

export function syncActivityVisibility(viewState) {
  const turn = viewState.activeTurn;
  if (!turn) return;
  turn.activity.hidden = turn.activity.childElementCount === 0;
}

export function clearToolCards(viewState) {
  for (const { card } of viewState.toolCards.values()) {
    card.remove();
  }
  viewState.toolCards.clear();
  viewState.activeTurn?.activity?.querySelectorAll(".turn-progress").forEach((el) => el.remove());
  syncActivityVisibility(viewState);
}

export function syncTurnProgress(viewState) {
  if (!viewState.activeTurn?.activity) return;

  const progress = viewState.activeTurn.activity.querySelector(".turn-progress");
  const waiting = store.get("isBusy") && countRunningTools(viewState.toolCards) === 0;

  if (waiting) {
    if (!progress) {
      const row = document.createElement("div");
      row.className = "turn-progress tool-card tool-card-running";
      const dot = document.createElement("span");
      dot.className = "tool-card-dot";
      const label = document.createElement("span");
      label.className = "tool-card-label";
      label.textContent = t("message.continuing");
      row.append(dot, label);
      viewState.activeTurn.activity.appendChild(row);
    }
    viewState.activeTurn.activity.hidden = false;
  } else if (progress) {
    progress.remove();
  }
}

export function updateBusyMeta(viewState) {
  const meta = $("sessionMeta");
  if (!meta || !store.get("isBusy")) return;
  meta.textContent = viewState.activityLabel || t("message.processing");
}

export function refreshRunningActivityLabel(viewState) {
  for (const entry of viewState.toolCards.values()) {
    if (entry.status !== "running") continue;
    const summary = toolSummary(entry.name, entry.input);
    viewState.activityLabel = summary.detail
      ? `${summary.title}：${summary.detail}`
      : summary.title;
    updateBusyMeta(viewState);
    return;
  }
  if (store.get("isBusy")) {
    viewState.activityLabel = t("message.continuing");
    updateBusyMeta(viewState);
  }
}
