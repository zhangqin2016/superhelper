import store from "./state.js";
import { t } from "../i18n/index.js";
import {
  getCachedRuntimeSessionIds,
  getRuntimeSession,
  subscribeRuntime,
} from "./session-runtime-store.js";

const MAX_VISIBLE_ITEMS = 8;

function sessionIndex(projects = []) {
  const byId = new Map();
  for (const project of projects || []) {
    for (const session of project.sessions || []) {
      byId.set(session.id, { session, project });
    }
  }
  return byId;
}

function basename(value = "") {
  const text = String(value || "");
  if (!text) return "";
  return text.split(/[/\\]/).filter(Boolean).pop() || text;
}

function runtimeHasAwaitingInput(runtime) {
  const live = runtime?.liveTurn;
  return Boolean(
    live?.questions?.size ||
    live?.permissions?.size ||
    live?.hooks?.size,
  );
}

function latestAssistantSnippet(runtime) {
  const live = runtime?.liveTurn;
  const text = live?.final?.payload?.assistant || live?.assistantText || "";
  if (String(text).trim()) return String(text).trim();
  const last = [...(runtime?.committedMessages || [])]
    .reverse()
    .find((message) => message?.role === "assistant" && String(message.content || "").trim());
  return String(last?.content || "").trim();
}

function countArtifacts(runtime) {
  const live = runtime?.liveTurn;
  if (Array.isArray(live?.artifacts)) return live.artifacts.length;
  const blocks = Array.isArray(live?.resultBlocks) ? live.resultBlocks : [];
  return blocks.filter((block) => block?.kind === "artifact").length;
}

function statusForRuntime(runtime) {
  if (!runtime) return null;
  if (runtime.phase !== "idle") {
    if (runtimeHasAwaitingInput(runtime)) return "waiting";
    if (runtime.phase === "stopping") return "stopping";
    return "running";
  }
  if (runtime.attention === "failed") return "failed";
  if (runtime.attention === "done") return "done";
  if (runtime.queue?.length) return "queued";
  return null;
}

function statusWeight(status) {
  return {
    failed: 0,
    waiting: 1,
    running: 2,
    stopping: 3,
    queued: 4,
    done: 5,
  }[status] ?? 9;
}

export function buildTaskCenterItems({ projects = [], activeSessionId = "", runtimes = [] } = {}) {
  const known = sessionIndex(projects);
  const items = [];
  for (const runtime of runtimes) {
    if (!runtime?.sessionId) continue;
    const status = statusForRuntime(runtime);
    if (!status) continue;
    const match = known.get(runtime.sessionId);
    const sessionTitle = match?.session?.title || t("taskCenter.untitledSession");
    const projectLabel = basename(match?.project?.path) || match?.project?.name || t("taskCenter.unknownWorkspace");
    const queueCount = Array.isArray(runtime.queue) ? runtime.queue.length : 0;
    const artifactCount = countArtifacts(runtime);
    items.push({
      sessionId: runtime.sessionId,
      turnId: runtime.turnId || runtime.liveTurn?.turnId || "",
      status,
      active: runtime.sessionId === activeSessionId,
      sessionTitle,
      projectLabel,
      queueCount,
      artifactCount,
      snippet: latestAssistantSnippet(runtime),
      startedAt: runtime.liveTurn?.startedAt || runtime._turnStartedAt || 0,
      weight: statusWeight(status),
    });
  }
  items.sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight;
    return Number(b.startedAt || 0) - Number(a.startedAt || 0);
  });
  return items;
}

function collectRuntimeItems() {
  const ids = new Set(getCachedRuntimeSessionIds());
  const active = store.get("activeSessionId");
  if (active) ids.add(active);
  return [...ids].map((sessionId) => getRuntimeSession(sessionId));
}

function statusLabel(status) {
  return t(`taskCenter.status.${status}`);
}

function detailsText(item) {
  const parts = [];
  if (item.queueCount) parts.push(t("taskCenter.queueCount", { count: item.queueCount }));
  if (item.artifactCount) parts.push(t("taskCenter.artifactCount", { count: item.artifactCount }));
  if (item.snippet && (item.status === "done" || item.status === "failed")) {
    parts.push(item.snippet.slice(0, 80));
  }
  return parts.join(" · ");
}

function renderSignature(items) {
  return JSON.stringify(items.slice(0, MAX_VISIBLE_ITEMS).map((item) => ({
    sessionId: item.sessionId,
    status: item.status,
    active: item.active,
    statusLabel: statusLabel(item.status),
    sessionTitle: item.sessionTitle,
    projectLabel: item.projectLabel,
    details: detailsText(item),
  })));
}

function renderSummary(items) {
  if (!items.length) return "";
  const failed = items.filter((item) => item.status === "failed").length;
  const waiting = items.filter((item) => item.status === "waiting").length;
  const running = items.filter((item) => item.status === "running" || item.status === "stopping").length;
  const queued = items.reduce((sum, item) => sum + (item.queueCount || 0), 0);
  if (failed) return t("taskCenter.summaryFailed", { count: failed });
  if (waiting) return t("taskCenter.summaryWaiting", { count: waiting });
  if (running) return t("taskCenter.summaryRunning", { count: running });
  if (queued) return t("taskCenter.summaryQueued", { count: queued });
  return t("taskCenter.summaryDone", { count: items.length });
}

async function focusSession(sessionId) {
  if (!sessionId || sessionId === store.get("activeSessionId")) return;
  const sw = await window.assistantClient?.switchSession?.(sessionId);
  const { applySessionSwitch } = await import("./session-chrome.js");
  const projectId = findProjectIdForSession(sessionId);
  await applySessionSwitch(sw, sessionId, projectId);
}

function findProjectIdForSession(sessionId) {
  for (const project of store.get("projects") || []) {
    if ((project.sessions || []).some((session) => session.id === sessionId)) return project.id;
  }
  return "";
}

function renderItem(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `task-center-item is-${item.status}${item.active ? " is-active" : ""}`;
  button.dataset.sessionId = item.sessionId;

  const status = document.createElement("span");
  status.className = "task-center-item-status";
  status.textContent = statusLabel(item.status);

  const main = document.createElement("span");
  main.className = "task-center-item-main";
  const title = document.createElement("strong");
  title.textContent = item.sessionTitle;
  const meta = document.createElement("span");
  meta.textContent = item.projectLabel;
  main.append(title, meta);

  const details = document.createElement("span");
  details.className = "task-center-item-details";
  details.textContent = detailsText(item);

  button.append(status, main, details);
  button.addEventListener("click", () => {
    void focusSession(item.sessionId);
    closePanel();
  });
  return button;
}

function closePanel() {
  const panel = document.getElementById("taskCenterPanel");
  const toggle = document.getElementById("taskCenterToggle");
  if (panel) panel.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

export function renderTaskCenter() {
  const dock = document.getElementById("taskCenterDock");
  const toggle = document.getElementById("taskCenterToggle");
  const panel = document.getElementById("taskCenterPanel");
  const summary = document.getElementById("taskCenterSummary");
  const count = document.getElementById("taskCenterCount");
  if (!dock || !toggle || !panel || !summary || !count) return;

  const items = buildTaskCenterItems({
    projects: store.get("projects") || [],
    activeSessionId: store.get("activeSessionId"),
    runtimes: collectRuntimeItems(),
  });

  dock.hidden = items.length === 0;
  if (!items.length) {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    panel.replaceChildren();
    delete panel.dataset.renderSignature;
    return;
  }

  summary.textContent = renderSummary(items);
  count.textContent = String(items.length);
  dock.dataset.severity = items[0]?.status || "running";
  const nextSignature = renderSignature(items);
  if (panel.dataset.renderSignature !== nextSignature) {
    panel.replaceChildren(...items.slice(0, MAX_VISIBLE_ITEMS).map(renderItem));
    panel.dataset.renderSignature = nextSignature;
  }
}

export function initTaskCenter() {
  const toggle = document.getElementById("taskCenterToggle");
  const panel = document.getElementById("taskCenterPanel");
  if (!toggle || !panel) return;
  toggle.addEventListener("click", () => {
    const next = panel.hidden;
    panel.hidden = !next;
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
  });
  document.addEventListener("click", (event) => {
    const dock = document.getElementById("taskCenterDock");
    if (!dock || dock.hidden || dock.contains(event.target)) return;
    closePanel();
  });
  store.on("projects", renderTaskCenter);
  store.on("activeSessionId", renderTaskCenter);
  subscribeRuntime(renderTaskCenter);
  renderTaskCenter();
}
