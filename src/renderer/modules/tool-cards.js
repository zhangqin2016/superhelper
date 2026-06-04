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

function currentStatusText(viewState) {
  const startedAt = viewState.turnStartedAt || Date.now();
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= 30000) return t("message.longWorking");
  return viewState.activityLabel || t("message.continuing");
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

function ensureCompactToolLayout(activity) {
  if (activity.querySelector(".tool-current-slot")) return;

  const bar = buildToolSummaryBar();
  bar.hidden = true;

  const currentSlot = document.createElement("div");
  currentSlot.className = "tool-current-slot";

  const progressSlot = document.createElement("div");
  progressSlot.className = "turn-progress-slot";
  progressSlot.hidden = true;

  const wrap = document.createElement("div");
  wrap.className = "tool-cards-wrap";

  activity.prepend(wrap);
  activity.prepend(progressSlot);
  activity.prepend(currentSlot);
  activity.prepend(bar);
  activity.classList.add("tool-steps-compact", "tool-collapsed");
}

/** Progress rows must live inside activity; legacy code appended them as body siblings. */
function removeStrayTurnProgress(viewState) {
  const turn = viewState.activeTurn;
  if (!turn) return;
  const body = turn.activity?.parentElement;
  body?.querySelectorAll(":scope > .turn-progress").forEach((el) => el.remove());
}

function ensureTurnProgressSlot(activity) {
  ensureCompactToolLayout(activity);
  let slot = activity.querySelector(".turn-progress-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "turn-progress-slot";
    slot.hidden = true;
    const { currentSlot } = getCompactParts(activity);
    (currentSlot || activity).after(slot);
  }
  return slot;
}

function turnHasStreamedText(viewState) {
  return (
    Boolean(viewState.activeMarkdown?.trim()) ||
    Boolean(viewState.activeBubble?.textContent?.trim())
  );
}

function getCompactParts(activity) {
  return {
    bar: activity.querySelector(".tool-summary-bar"),
    currentSlot: activity.querySelector(".tool-current-slot"),
    wrap: activity.querySelector(".tool-cards-wrap"),
  };
}

function syncToolSummaryBar(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;
  const { bar, wrap } = getCompactParts(activity);
  if (!bar || !wrap) return;

  const doneCount = wrap.querySelectorAll(".tool-card").length;
  if (doneCount === 0) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  const collapsed = activity.classList.contains("tool-collapsed");
  const prefix = collapsed ? "▶ " : "▼ ";
  bar.textContent = prefix + t("tool.summaryBar", { count: doneCount });
}

function toggleToolStepsExpanded(activity) {
  if (!activity) return;
  const collapsed = activity.classList.toggle("tool-collapsed");
  const { bar } = getCompactParts(activity);
  if (bar && !bar.hidden) {
    const text = bar.textContent.replace(/^[▶▼]\s*/, "");
    bar.textContent = (collapsed ? "▶ " : "▼ ") + text;
  }
}

function archiveCardToWrap(viewState, card) {
  const activity = viewState.activeTurn?.activity;
  if (!activity || !card?.isConnected) return;
  ensureCompactToolLayout(activity);
  const { wrap } = getCompactParts(activity);
  if (!wrap) return;
  wrap.appendChild(card);
  syncToolSummaryBar(viewState);
}

function mountRunningToolCard(viewState, card, id, name, input) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;
  ensureCompactToolLayout(activity);
  const { currentSlot, wrap } = getCompactParts(activity);

  // Defensive: if a previous running card is still in the slot, archive it.
  if (currentSlot && wrap) {
    for (const child of [...currentSlot.children]) {
      if (child.classList.contains("tool-card")) {
        wrap.appendChild(child);
      }
    }
  }

  if (currentSlot) {
    currentSlot.appendChild(card);
  } else {
    activity.appendChild(card);
  }
  viewState.toolCards.set(id, { card, name, input, status: "running" });
  syncToolSummaryBar(viewState);
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

  mountRunningToolCard(viewState, card, id, name, input);
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

  mountRunningToolCard(viewState, card, id, name, {});
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

    archiveCardToWrap(viewState, entry.card);
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
  const activity = turn.activity;
  const hasCurrent = activity.querySelector(".tool-current-slot .tool-card");
  const hasArchived = activity.querySelector(".tool-cards-wrap .tool-card");
  const hasProgress =
    Boolean(
      activity.querySelector(".turn-progress-slot:not([hidden]) .turn-progress"),
    ) || Boolean(activity.querySelector(".turn-progress"));
  const hasEngine = activity.querySelector(".engine-notice-card");
  const bar = activity.querySelector(".tool-summary-bar");
  const barVisible = bar && !bar.hidden;
  activity.hidden = !(hasCurrent || hasArchived || hasProgress || hasEngine || barVisible);
}

export function clearToolCards(viewState) {
  for (const { card } of viewState.toolCards.values()) {
    card.remove();
  }
  viewState.toolCards.clear();
  if (viewState.engineNotices) {
    for (const { card } of viewState.engineNotices.values()) {
      card?.remove();
    }
    viewState.engineNotices.clear();
  }
  const activity = viewState.activeTurn?.activity;
  activity?.querySelector(".tool-current-slot")?.replaceChildren();
  activity?.querySelector(".tool-cards-wrap")?.replaceChildren();
  activity?.querySelector(".turn-progress-slot")?.replaceChildren();
  activity?.querySelectorAll(".turn-progress").forEach((el) => el.remove());
  removeStrayTurnProgress(viewState);
  const bar = activity?.querySelector(".tool-summary-bar");
  if (bar) bar.hidden = true;
  syncActivityVisibility(viewState);
}

function buildToolSummaryBar() {
  const bar = document.createElement("div");
  bar.className = "tool-summary-bar";
  bar.addEventListener("click", () => {
    const activity = bar.closest(".tool-activity");
    toggleToolStepsExpanded(activity);
  });
  return bar;
}

export function collapseToolCards(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;

  ensureCompactToolLayout(activity);
  const { currentSlot, wrap } = getCompactParts(activity);
  if (!wrap) return;

  if (currentSlot) {
    for (const child of [...currentSlot.children]) {
      if (child.classList.contains("tool-card")) {
        wrap.appendChild(child);
      }
    }
  }

  // Legacy: cards appended directly under activity
  for (const card of [...activity.querySelectorAll(":scope > .tool-card")]) {
    if (!card.classList.contains("turn-progress")) {
      wrap.appendChild(card);
    }
  }

  activity.querySelector(".turn-progress-slot")?.replaceChildren();
  activity.querySelectorAll(".turn-progress").forEach((el) => el.remove());

  activity.classList.add("tool-collapsed");
  syncToolSummaryBar(viewState);
}

export function expandToolCards(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;
  activity.classList.remove("tool-collapsed");
  syncToolSummaryBar(viewState);
}

export function syncTurnProgress(viewState) {
  if (!viewState.activeTurn?.activity) return;

  removeStrayTurnProgress(viewState);

  const activity = viewState.activeTurn.activity;
  const slot = ensureTurnProgressSlot(activity);
  const waiting =
    store.get("isBusy") &&
    countRunningTools(viewState.toolCards) === 0;

  activity.querySelectorAll(".turn-progress").forEach((el) => {
    if (el.parentElement !== slot) el.remove();
  });

  if (!waiting) {
    slot.replaceChildren();
    slot.hidden = true;
    syncActivityVisibility(viewState);
    return;
  }

  let progress = slot.querySelector(".turn-progress");
  const labelText = currentStatusText(viewState);
  if (!progress) {
    progress = document.createElement("div");
    progress.className = "turn-progress tool-card tool-card-running";
    const dot = document.createElement("span");
    dot.className = "tool-card-dot";
    const label = document.createElement("span");
    label.className = "tool-card-label";
    progress.append(dot, label);
    slot.appendChild(progress);
  }
  const label = progress.querySelector(".tool-card-label");
  if (label) label.textContent = labelText;

  slot.hidden = false;
  activity.hidden = false;
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
    viewState.activityLabel = turnHasStreamedText(viewState)
      ? t("message.organizingReply")
      : t("message.continuing");
  }
}
