/**
 * Turn Timeline — the single renderer for one Claude CLI turn.
 *
 * Claude CLI behaves like a terminal TUI: thinking, tool use, permissions,
 * background work and final reply are one continuous workflow. This module
 * owns that workflow in the chat UI. `message.js` should route all turn
 * activity here instead of mixing independent tool/engine progress paths.
 */
import { scrollToBottom } from "./dom.js";
import { canSend, getTurnPhase } from "./session-busy.js";
import { t } from "../i18n/index.js";
import { renderStreamingMarkdown, renderMarkdownWithCache } from "./markdown.js";

const LIVE_TICK_MS = 1000;

function basename(path) {
  if (!path) return "";
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || String(path);
}

function clip(text, max = 96) {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function elapsedText(startedAt) {
  const elapsedMs = Date.now() - (Number(startedAt) || Date.now());
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
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
      return { title: t("tool.subagentTask"), detail: clip(input.description || input.prompt || input.task) };
    case "Agent":
    case "Subagent":
      return { title: t("tool.subagent"), detail: clip(input.description || input.prompt) };
    case "ExitPlanMode":
      return { title: t("tool.exitPlanMode"), detail: clip(input.plan || input.summary || input.reason) };
    case "EnterPlanMode":
      return { title: t("tool.enterPlanMode"), detail: "" };
    default:
      return {
        title: name || t("tool.processing"),
        detail: clip(input.query || input.prompt || input.description || input.file_path || input.path),
      };
  }
}

export function engineNoticeText(payload) {
  if (!payload?.code) return payload?.message || payload?.detail || "";
  const model =
    typeof payload.model === "string" && payload.model.trim()
      ? ` · ${payload.model.trim()}`
      : "";
  const params = {
    model,
    attempt: payload.attempt || 1,
    maxRetries: payload.maxRetries || "...",
    detail: payload.detail || payload.message || "",
    subtype: payload.subtype || "",
    type: payload.type || "",
  };
  if (!params.detail && String(payload.code || "").startsWith("task")) {
    params.detail = t("engine.taskGeneric");
  }
  if (!params.detail && payload.code === "thinkingProgress") {
    params.detail = t("engine.thinkingGeneric");
  }
  const key = `engine.${payload.code}`;
  const translated = t(key, params);
  if (translated !== key) return translated;
  return payload.detail || payload.message || t("engine.fallback");
}

function ensureTimeline(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return null;

  if (!viewState.timeline) {
    viewState.timeline = {
      tools: new Map(),
      notices: new Map(),
      liveNoticeId: "",
      runningFallback: null,
      timer: null,
    };
  }

  let root = activity.querySelector(".turn-timeline");
  if (!root) {
    root = document.createElement("div");
    root.className = "turn-timeline";

    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "tool-summary-bar turn-timeline-summary";
    summary.hidden = true;
    summary.addEventListener("click", () => {
      root.classList.toggle("turn-timeline-collapsed");
      syncSummary(viewState);
    });

    const live = document.createElement("div");
    live.className = "turn-timeline-live";

    const history = document.createElement("div");
    history.className = "tool-cards-wrap turn-timeline-history";

    root.append(summary, live, history);
    activity.prepend(root);
  }

  activity.hidden = false;
  return root;
}

function timelineParts(viewState) {
  const root = ensureTimeline(viewState);
  if (!root) return {};
  return {
    root,
    summary: root.querySelector(".turn-timeline-summary"),
    live: root.querySelector(".turn-timeline-live"),
    history: root.querySelector(".turn-timeline-history"),
  };
}

function setStatus(card, text) {
  const status = card.querySelector(".tool-card-status");
  if (status) status.textContent = text;
}

function buildRow({ id = "", name = "", title, detail = "", running = true, kind = "tool" }) {
  const card = document.createElement("div");
  card.className = `tool-card ${running ? "tool-card-running" : "tool-card-done"}`;
  if (id) card.dataset.toolId = id;
  if (name) card.dataset.toolName = name;
  card.dataset.timelineKind = kind;

  const dot = document.createElement("span");
  dot.className = "tool-card-dot";
  if (!running) dot.classList.add("tool-card-dot-done");

  const main = document.createElement("div");
  main.className = "tool-card-main";

  const header = document.createElement("div");
  header.className = "tool-card-header";

  const label = document.createElement("span");
  label.className = "tool-card-label";
  label.textContent = title;

  const status = document.createElement("span");
  status.className = "tool-card-status";
  status.textContent = running ? t("timeline.statusRunning") : t("timeline.statusDone");

  header.append(label, status);
  main.appendChild(header);

  const detailEl = document.createElement("span");
  detailEl.className = "tool-card-detail";
  detailEl.textContent = detail;
  if (!detail) detailEl.hidden = true;
  main.appendChild(detailEl);

  card.append(dot, main);
  return card;
}

function updateRow(card, { title, detail, running, failed = false, statusText }) {
  if (title) card.querySelector(".tool-card-label").textContent = title;
  const detailEl = card.querySelector(".tool-card-detail");
  if (detailEl) {
    detailEl.textContent = detail || "";
    detailEl.hidden = !detail;
  }
  card.classList.remove("tool-card-running", "tool-card-done", "tool-card-failed");
  card.classList.add(failed ? "tool-card-failed" : running ? "tool-card-running" : "tool-card-done");
  if (!running && !failed) card.querySelector(".tool-card-dot")?.classList.add("tool-card-dot-done");
  setStatus(card, statusText || (failed ? t("timeline.statusFailed") : running ? t("timeline.statusRunning") : t("timeline.statusDone")));
}

function mountLive(viewState, card) {
  const { live, history } = timelineParts(viewState);
  if (!live) return;
  for (const child of [...live.children]) {
    if (child.classList.contains("tool-card")) history?.appendChild(child);
  }
  live.appendChild(card);
}

function archiveLive(viewState, card) {
  const { history } = timelineParts(viewState);
  if (history && card?.isConnected) history.appendChild(card);
  syncSummary(viewState);
}

export function countRunningTools(toolCards) {
  let n = 0;
  for (const entry of toolCards.values()) {
    if (entry.status === "running") n++;
  }
  return n;
}

export function addToolCard(viewState, id, name, input = {}) {
  if (!viewState.activeTurn) return;
  const summary = toolSummary(name, input);
  const card = buildRow({
    id,
    name,
    title: summary.title,
    detail: summary.detail,
    running: true,
    kind: "tool",
  });
  if (["Write", "Edit", "MultiEdit"].includes(name)) {
    const fp = input?.file_path || input?.path || input?.target_file;
    if (fp) card.dataset.toolFilePath = fp;
  }
  viewState.toolCards.set(id, { card, name, input, status: "running" });
  viewState.activityLabel = summary.detail ? `${summary.title}：${summary.detail}` : summary.title;
  viewState.activityLabelSource = "tool";
  mountLive(viewState, card);
  scrollToBottom(false, viewState.panel);
}

export function addToolCardPlaceholder(viewState, id, name) {
  addToolCard(viewState, id, name, {});
}

export function updateToolCardInput(viewState, id, partialJson) {
  const entry = viewState.toolCards.get(id);
  if (!entry) return;
  const updated = `${entry._streamedInput || ""}${partialJson || ""}`;
  entry._streamedInput = updated;
  const preview = updated
    .replace(/^[{,"'\s]+/, "")
    .replace(/[}:,"']/g, " ")
    .trim()
    .slice(0, 100);
  updateRow(entry.card, { detail: preview || "...", running: true });
}

export function finalizeToolCardInput(viewState, id, input = {}) {
  const entry = viewState.toolCards.get(id);
  if (!entry) return;
  entry.input = input;
  entry._streamedInput = null;
  const summary = toolSummary(entry.name, input);
  if (["Write", "Edit", "MultiEdit"].includes(entry.name)) {
    const fp = input?.file_path || input?.path || input?.target_file;
    if (fp) entry.card.dataset.toolFilePath = fp;
  }
  updateRow(entry.card, { title: summary.title, detail: summary.detail, running: true });
  refreshRunningActivityLabel(viewState);
}

export function updateToolCard(viewState, id, status, result) {
  const entry = viewState.toolCards.get(id);
  if (!entry) return;
  const failed = status === "failed";
  updateRow(entry.card, {
    running: false,
    failed,
    title: failed ? t("message.toolFailed", { title: toolSummary(entry.name, entry.input).title }) : null,
    statusText: result?.detached ? t("timeline.statusDetached") : undefined,
  });
  entry.status = failed ? "failed" : "done";
  if (result?.content) appendToolResult(entry.card, result.content);
  archiveLive(viewState, entry.card);
  syncActivityVisibility(viewState);
  refreshRunningActivityLabel(viewState);
}

function appendToolResult(card, content) {
  card.querySelector(".tool-card-result")?.remove();
  const text = String(content || "");
  if (!text) return;
  const result = document.createElement("div");
  result.className = "tool-card-result";
  result.textContent = text.length > 300 ? `${text.slice(0, 300)}\n...` : text;
  card.appendChild(result);
}

function noticeDetail(payload, entry) {
  if (payload?.code !== "thinkingProgress") return payload?.detail || payload?.message || "";
  // Only show elapsed time during thinking — token counts are internal detail
  return elapsedText(entry.startedAt);
}

function noticeText(payload, entry) {
  return engineNoticeText({ ...payload, detail: noticeDetail(payload, entry) });
}

export function addOrUpdateEngineNotice(viewState, payload) {
  if (!viewState.activeTurn || payload?.panel === false) return;
  ensureTimeline(viewState);
  if (!viewState.engineNotices) viewState.engineNotices = new Map();

  const code = String(payload.code || "generic");
  const id = payload.replace ? `notice:${code}` : `notice:${code}:${Date.now()}`;
  const done = Boolean(payload.done);
  const failed = payload.level === "warning";
  let entry = viewState.engineNotices.get(id);

  if (!entry) {
    entry = {
      id,
      code,
      payload: { ...payload },
      startedAt: Date.now(),
      status: failed ? "failed" : done ? "done" : "running",
      card: buildRow({
        title: "",
        detail: "",
        running: !done && !failed,
        failed,
        kind: "notice",
      }),
      timer: null,
    };
    entry.card.classList.add("engine-notice-card");
    viewState.engineNotices.set(id, entry);
    mountLive(viewState, entry.card);
  } else {
    entry.payload = { ...entry.payload, ...payload };
    entry.status = failed ? "failed" : done ? "done" : "running";
  }

  updateRow(entry.card, {
    title: noticeText(entry.payload, entry),
    running: entry.status === "running",
    failed,
  });
  syncNoticeTimer(entry);
}

function syncNoticeTimer(entry) {
  if (entry.status !== "running" || entry.code !== "thinkingProgress") {
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    return;
  }
  if (entry.timer) return;
  entry.timer = window.setInterval(() => {
    if (!entry.card?.isConnected || entry.status !== "running") {
      clearInterval(entry.timer);
      entry.timer = null;
      return;
    }
    updateRow(entry.card, {
      title: noticeText(entry.payload, entry),
      running: true,
    });
  }, LIVE_TICK_MS);
}

export function finishTimeline(viewState) {
  if (viewState.engineNotices) {
    for (const entry of viewState.engineNotices.values()) {
      if (entry.timer) clearInterval(entry.timer);
      entry.timer = null;
      if (entry.status === "running") {
        entry.status = "done";
        updateRow(entry.card, {
          title: noticeText(entry.payload, entry),
          running: false,
        });
        archiveLive(viewState, entry.card);
      }
    }
  }
  for (const entry of viewState.toolCards.values()) {
    if (entry.status === "running") {
      entry.status = "done";
      updateRow(entry.card, { running: false });
      archiveLive(viewState, entry.card);
    }
  }
  // Archive text entries still in the live area
  const textCard = viewState.timeline?._textCard;
  if (textCard?.isConnected && !textCard.classList.contains("turn-text-entry-final")) {
    textCard.classList.add("turn-text-entry-final");
    const { history } = timelineParts(viewState);
    if (history) history.appendChild(textCard);
    viewState.timeline._textCard = null;
  }
  clearFallback(viewState);
  syncSummary(viewState);
}

export function clearTimeline(viewState) {
  if (viewState.engineNotices) {
    for (const entry of viewState.engineNotices.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    viewState.engineNotices.clear();
  }
  viewState.toolCards.clear();
  viewState.timeline._textCard = null;
  viewState.timeline._lastTextRender = 0;
  viewState.timeline._lastTextLen = 0;
  clearFallback(viewState);
  viewState.activeTurn?.activity?.querySelector(".turn-timeline")?.remove();
  syncActivityVisibility(viewState);
}

export function collapseTimeline(viewState) {
  finishTimeline(viewState);
}

function currentStatusText(viewState) {
  const phase = getTurnPhase(viewState.sessionId);
  if (phase === "sending" || phase === "stopping" || phase === "closing") return t("message.processing");
  if (viewState.activityLabel) return viewState.activityLabel;
  const elapsedMs = Date.now() - (viewState.turnStartedAt || Date.now());
  return elapsedMs >= 30000 ? t("message.longWorking") : t("message.continuing");
}

export function syncTurnProgress(viewState) {
  if (!viewState.activeTurn?.activity) return;

  // Skip fallback when streaming text — the reply bubble IS the progress indicator
  if (viewState.activeBubble?.dataset?.streamMode || viewState.activeMarkdown) {
    clearFallback(viewState);
    syncActivityVisibility(viewState);
    return;
  }

  const waiting =
    Boolean(viewState.sessionId && !canSend(viewState.sessionId)) &&
    countRunningTools(viewState.toolCards) === 0 &&
    !hasRunningNotice(viewState);

  if (!waiting) {
    clearFallback(viewState);
    syncActivityVisibility(viewState);
    return;
  }
  const { live } = timelineParts(viewState);
  if (!live) return;
  if (!viewState.timeline.runningFallback?.isConnected) {
    viewState.timeline.runningFallback = buildRow({
      title: currentStatusText(viewState),
      running: true,
      kind: "fallback",
    });
    live.appendChild(viewState.timeline.runningFallback);
  } else {
    updateRow(viewState.timeline.runningFallback, {
      title: currentStatusText(viewState),
      running: true,
    });
  }
  viewState.activeTurn.activity.hidden = false;
}

function clearFallback(viewState) {
  viewState.timeline?.runningFallback?.remove();
  if (viewState.timeline) viewState.timeline.runningFallback = null;
}

function hasRunningNotice(viewState) {
  if (!viewState.engineNotices) return false;
  for (const entry of viewState.engineNotices.values()) {
    if (entry.status === "running") return true;
  }
  return false;
}

export function updateToolCardProgress(viewState, _toolName, message) {
  for (const entry of viewState.toolCards.values()) {
    if (entry.status === "running") {
      updateRow(entry.card, { detail: message, running: true });
    }
  }
}

export function refreshRunningActivityLabel(viewState) {
  for (const entry of viewState.toolCards.values()) {
    if (entry.status !== "running") continue;
    const summary = toolSummary(entry.name, entry.input);
    viewState.activityLabel = summary.detail ? `${summary.title}：${summary.detail}` : summary.title;
    viewState.activityLabelSource = "tool";
    return;
  }
  if (viewState.activityLabelSource === "engine") return;
  if (viewState.sessionId && !canSend(viewState.sessionId)) {
    viewState.activityLabel = viewState.activeMarkdown?.trim()
      ? t("message.generatingReply")
      : t("message.continuing");
  }
}

export function syncActivityVisibility(viewState) {
  const activity = viewState.activeTurn?.activity;
  if (!activity) return;
  const root = activity.querySelector(".turn-timeline");
  const hasTimeline = Boolean(root?.querySelector(".tool-card, .turn-text-entry, .tool-summary-bar:not([hidden])"));
  const hasPermission = Boolean(activity.querySelector(".permission-prompt"));
  activity.hidden = !(hasTimeline || hasPermission);
}

// --- Inline text entries (model thinking between tools) ---

function ensureTextEntry(viewState) {
  ensureTimeline(viewState);
  if (!viewState.timeline._textCard?.isConnected) {
    const card = document.createElement("div");
    card.className = "turn-text-entry";
    card.dataset.timelineKind = "text";
    viewState.timeline._textCard = card;
    const { live } = timelineParts(viewState);
    live?.appendChild(card);
  }
  return viewState.timeline._textCard;
}

export function addTextEntry(viewState) {
  // When real text arrives, dismiss the thinking indicator
  if (viewState.engineNotices) {
    for (const [id, entry] of viewState.engineNotices) {
      if (entry.code === "thinkingProgress" && entry.status === "running") {
        entry.status = "done";
        entry.timer && clearInterval(entry.timer);
        updateRow(entry.card, { running: false });
        archiveLive(viewState, entry.card);
      }
    }
  }
  clearFallback(viewState);
  return ensureTextEntry(viewState);
}

const TEXT_RENDER_MS = 80;

export function updateTextEntry(viewState, markdownText) {
  const card = ensureTextEntry(viewState);
  const now = performance.now();
  const last = viewState.timeline._lastTextRender || 0;
  const len = markdownText?.length || 0;
  const lastLen = viewState.timeline._lastTextLen || 0;
  // First chunk always renders immediately; subsequent chunks throttle
  if (last > 0 && now - last < TEXT_RENDER_MS && (len - lastLen) < 200) return;
  renderStreamingMarkdown(card, markdownText);
  viewState.timeline._lastTextRender = now;
  viewState.timeline._lastTextLen = len;
}

export function finalizeTextEntry(viewState, finalMarkdown) {
  const card = viewState.timeline?._textCard;
  if (!card?.isConnected) return;
  if (finalMarkdown) {
    renderMarkdownWithCache(card, finalMarkdown);
  }
  card.classList.add("turn-text-entry-final");
  const { history } = timelineParts(viewState);
  if (history) history.appendChild(card);
  viewState.timeline._textCard = null;
}

function toolGroup(name) {
  switch (name) {
    case "Read":
      return "read";
    case "Write":
    case "Edit":
    case "MultiEdit":
      return "write";
    case "Grep":
    case "Glob":
      return "search";
    case "Bash":
      return "command";
    case "WebSearch":
    case "web_search_prime":
    case "webReader":
      return "web";
    case "Task":
    case "Agent":
    case "Subagent":
      return "agent";
    default:
      return "other";
  }
}

function syncSummary(viewState) {
  const { root, summary, history } = timelineParts(viewState);
  if (!summary || !history) return;
  const cards = [...history.querySelectorAll(".tool-card")];
  if (!cards.length) {
    summary.hidden = true;
    return;
  }
  const counts = new Map();
  for (const card of cards) {
    if (card.dataset.timelineKind !== "tool") continue;
    const group = toolGroup(card.dataset.toolName || "");
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  const parts = [
    ["read", "timeline.summaryRead"],
    ["search", "timeline.summarySearch"],
    ["write", "timeline.summaryWrite"],
    ["command", "timeline.summaryCommand"],
    ["web", "timeline.summaryWeb"],
    ["agent", "timeline.summaryAgent"],
  ]
    .map(([group, key]) => {
      const count = counts.get(group) || 0;
      return count > 0 ? t(key, { count }) : "";
    })
    .filter(Boolean);
  const otherCount = counts.get("other") || 0;
  if (otherCount > 0) parts.push(t("timeline.summaryOther", { count: otherCount }));
  const prefix = root.classList.contains("turn-timeline-collapsed") ? "▶ " : "▼ ";
  summary.hidden = false;
  summary.textContent = prefix + (parts.length ? parts.join(" · ") : t("timeline.stepsCompleted", { count: cards.length }));
}
