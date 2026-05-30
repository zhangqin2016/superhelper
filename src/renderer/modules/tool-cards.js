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
    case "ExitPlanMode":
      return {
        title: t("tool.exitPlanMode"),
        detail: clip(input.plan || input.summary || input.reason),
      };
    case "EnterPlanMode":
      return { title: t("tool.enterPlanMode"), detail: "" };
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

function insertCardAtPlace(viewState, card, id, name, input, parentToolUseId) {
  const parentTypes = ["Task", "Agent", "Subagent"];
  if (parentToolUseId) {
    const parentCard = viewState.activeTurn.activity.querySelector(
      `.tool-card[data-tool-id="${parentToolUseId}"]`
    );
    const parentEntry = viewState.toolCards.get(parentToolUseId);
    if (parentCard && parentEntry && parentTypes.includes(parentEntry.name)) {
      card.classList.add("tool-card-child");
      const siblings = parentCard.parentNode.querySelectorAll(
        `.tool-card-child[data-parent-id="${parentToolUseId}"]`
      );
      const lastSibling = siblings[siblings.length - 1];
      card.dataset.parentId = parentToolUseId;
      if (lastSibling) {
        lastSibling.after(card);
      } else {
        parentCard.after(card);
      }
      viewState.toolCards.set(id, { card, name, input, status: "running" });
      return;
    }
  }

  viewState.activeTurn.activity.appendChild(card);
  viewState.toolCards.set(id, { card, name, input, status: "running" });
}

export function addToolCard(viewState, id, name, input, parentToolUseId) {
  if (!viewState.activeTurn) return;

  const summary = toolSummary(name, input);
  viewState.activityLabel = summary.detail
    ? `${summary.title}：${summary.detail}`
    : summary.title;

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;
  // For diff-to-card linking — same fallback order as diff-capture.js extractFilePath
  if (["Write", "Edit", "MultiEdit"].includes(name)) {
    const fp = input?.file_path || input?.path || input?.target_file;
    if (fp) card.dataset.toolFilePath = fp;
  }
  renderToolCardContent(card, name, input);

  insertCardAtPlace(viewState, card, id, name, input, parentToolUseId);
  viewState.activeTurn.activity.hidden = false;
  scrollToBottom(false, viewState.panel);
}

/**
 * Create a placeholder card from content_block_start (name/id only, no input yet).
 * Updated later by addToolCard with full input.
 */
export function addToolCardPlaceholder(viewState, id, name, parentToolUseId) {
  if (!viewState.activeTurn) return;

  const summary = toolSummary(name, {});
  viewState.activityLabel = summary.title;

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;
  renderToolCardContent(card, name, {});

  insertCardAtPlace(viewState, card, id, name, {}, parentToolUseId);
  viewState.activeTurn.activity.hidden = false;
  scrollToBottom(false, viewState.panel);
}

/**
 * Stream input_json_delta into the tool card's detail text.
 */
export function updateToolCardInput(viewState, id, partialJson) {
  const entry = viewState.toolCards.get(id);
  if (!entry) return;
  const detailEl = entry.card.querySelector(".tool-card-detail");
  if (!detailEl) return;
  // Accumulate and try to extract human-readable info from partial JSON
  const detail = entry._streamedInput || "";
  const updated = detail + partialJson;
  entry._streamedInput = updated;
  // Show the partial input as detail — strip JSON noise for readability
  const preview = updated
    .replace(/^[{,"'\s]+/, "")
    .replace(/[}:,"']/g, " ")
    .trim()
    .slice(0, 80);
  detailEl.textContent = preview || "...";
}

/**
 * Finalize tool card with complete input from assistant event.
 */
export function finalizeToolCardInput(viewState, id, input) {
  const entry = viewState.toolCards.get(id);
  if (!entry) return;
  entry.input = input;
  entry._streamedInput = null;
  // Set diff-linking file path
  const name = entry.name;
  if (["Write", "Edit", "MultiEdit"].includes(name)) {
    const fp = input?.file_path || input?.path || input?.target_file;
    if (fp) entry.card.dataset.toolFilePath = fp;
  }
  renderToolCardContent(entry.card, name, input);
  refreshRunningActivityLabel(viewState);
}

export function updateToolCard(viewState, id, status, result) {
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

    // Show tool result if available
    if (result?.content) {
      appendToolResult(entry, result);
    }

    refreshRunningActivityLabel(viewState);
  }

  syncTurnProgress(viewState);
  syncActivityVisibility(viewState);
}

function appendToolResult(entry, result) {
  const existing = entry.card.querySelector(".tool-card-result");
  if (existing) existing.remove();

  const content = result.content || "";
  const truncated = content.length > 300 ? content.slice(0, 300) + "\n..." : content;

  const resultDiv = document.createElement("div");
  resultDiv.className = "tool-card-result";
  resultDiv.textContent = truncated;

  if (content.length > 300) {
    const toggle = document.createElement("button");
    toggle.className = "tool-card-result-toggle";
    toggle.textContent = "展开全部";
    let expanded = false;
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      resultDiv.textContent = expanded ? content : truncated;
      resultDiv.style.maxHeight = expanded ? "none" : "150px";
      toggle.textContent = expanded ? "收起" : "展开全部";
    });
    entry.card.appendChild(resultDiv);
    entry.card.appendChild(toggle);
  } else {
    entry.card.appendChild(resultDiv);
  }
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

function buildToolSummaryBar(count) {
  const bar = document.createElement("div");
  bar.className = "tool-summary-bar";
  bar.textContent = `${count} 个工具`;
  bar.addEventListener("click", () => {
    const activity = bar.closest(".tool-activity");
    if (!activity) return;
    const wrap = activity.querySelector(".tool-cards-wrap");
    if (activity.classList.contains("tool-collapsed")) {
      activity.classList.remove("tool-collapsed");
      if (wrap) wrap.hidden = false;
      bar.textContent = bar.textContent.replace("▶", "▼");
    } else {
      activity.classList.add("tool-collapsed");
      if (wrap) wrap.hidden = true;
      bar.textContent = bar.textContent.replace("▼", "▶");
    }
  });
  return bar;
}

export function collapseToolCards(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;
  const cards = activity.querySelectorAll(".tool-card:not(.turn-progress)");
  if (cards.length === 0) return;

  // Wrap existing cards
  const wrap = document.createElement("div");
  wrap.className = "tool-cards-wrap";
  while (cards[0] && cards[0].parentNode === activity) {
    wrap.appendChild(cards[0]);
  }
  // Move turn-progress into wrap if present
  const progress = activity.querySelector(".turn-progress");
  if (progress) wrap.appendChild(progress);

  const bar = buildToolSummaryBar(wrap.childElementCount);
  activity.insertBefore(bar, activity.firstChild);
  activity.insertBefore(wrap, bar.nextSibling);
  activity.classList.add("tool-collapsed");
  wrap.hidden = true;
  bar.textContent = "▶ " + bar.textContent;
}

export function expandToolCards(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;
  activity.classList.remove("tool-collapsed");
  const wrap = activity.querySelector(".tool-cards-wrap");
  if (wrap) wrap.hidden = false;
  const bar = activity.querySelector(".tool-summary-bar");
  if (bar) bar.textContent = bar.textContent.replace("▶", "▼");
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

export function updateToolCardProgress(viewState, toolName, message) {
  for (const entry of viewState.toolCards.values()) {
    if (entry.status === "running") {
      const detailEl = entry.card.querySelector(".tool-card-detail");
      if (detailEl) {
        detailEl.textContent = message;
        detailEl.classList.add("progress-active");
      }
    }
  }
}

export function refreshRunningActivityLabel(viewState) {
  for (const entry of viewState.toolCards.values()) {
    if (entry.status !== "running") continue;
    const summary = toolSummary(entry.name, entry.input);
    viewState.activityLabel = summary.detail
      ? `${summary.title}：${summary.detail}`
      : summary.title;
    return;
  }
  if (store.get("isBusy")) {
    viewState.activityLabel = t("message.continuing");
  }
}
