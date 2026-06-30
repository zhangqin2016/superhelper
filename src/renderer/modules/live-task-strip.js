// Pinned, collapsible task strip just above the composer. During a LIVE turn it
// shows the agent's current to-do list (the progress anchor for long tasks) so it
// never scrolls away — answering the "is it still working / how much is left?"
// question. Sealed/history turns keep their inline card (turn-view-renderer skips
// the inline card only while live, so there's no duplication).
import { isTodoTool, parseTodoEntries } from "./turn-process-layout.js";
import { t } from "../i18n/index.js";

let collapsed = false;
let wired = false;

function latestTodos(liveTurn) {
  const tools = liveTurn?.tools;
  if (!tools) return [];
  const values = tools instanceof Map ? [...tools.values()] : tools;
  let latest = null;
  for (const tool of values) if (isTodoTool(tool?.name)) latest = tool;
  return latest ? parseTodoEntries(latest) : [];
}

function taskRunStatusLabel(taskRun, translate) {
  const liveness = taskRun?.liveness || {};
  if (liveness.status === "no_visible_progress") return translate("task.strip.noVisibleProgress");
  if (liveness.status === "tool_running" || taskRun?.phase === "tool_running") return translate("task.strip.toolRunning");
  if (taskRun?.status === "awaiting_user") return translate("task.strip.awaitingUser");
  if (taskRun?.status === "stalled") return translate("task.strip.stalled");
  if (taskRun?.status === "failed") return translate("task.strip.failed");
  return translate("task.strip.running");
}

function isGenericTaskStep(title = "") {
  const normalized = String(title || "").trim().toLowerCase();
  return normalized === "execute with available tools";
}

function taskRunItems(taskRun, translate) {
  const items = [];
  const plan = Array.isArray(taskRun?.plan) ? taskRun.plan : [];
  const active = plan.find((step) => step.status === "in_progress") || plan.find((step) => step.id === taskRun?.activeStep);
  if (active?.title && !isGenericTaskStep(active.title)) {
    items.push({ status: "in_progress", content: translate("task.strip.step", { item: active.title }) });
  }
  const risk = Array.isArray(taskRun?.risks) ? taskRun.risks.at(-1) : null;
  if (risk?.code) {
    items.push({ status: risk.level === "warning" ? "warning" : "info", content: translate("task.strip.risk", { code: risk.code }) });
  }
  const evidenceCount = Array.isArray(taskRun?.evidence) ? taskRun.evidence.length : 0;
  if (evidenceCount > 0) {
    items.push({ status: "completed", content: translate("task.strip.evidence", { count: evidenceCount }) });
  }
  if (taskRun?.resumeState?.replaySafe === false) {
    items.push({ status: "warning", content: translate("task.strip.noAutoReplay") });
  }
  return items.slice(0, 5);
}

export function buildLiveTaskStripModel(liveTurn, translate = t) {
  if (!liveTurn || liveTurn.final) return { visible: false, summary: "", items: [] };
  const todos = latestTodos(liveTurn);
  const taskRun = liveTurn.taskRun || null;
  if (todos.length) {
    const done = todos.filter((todo) => todo.status === "completed").length;
    const inProgress = todos.find((todo) => todo.status === "in_progress");
    let summary = translate("todo.summary", { done, total: todos.length });
    if (inProgress) summary += ` · ${translate("task.strip.current", { item: inProgress.content })}`;
    else if (taskRun) summary += ` · ${taskRunStatusLabel(taskRun, translate)}`;
    return { visible: true, summary, items: todos };
  }
  if (!taskRun) return { visible: false, summary: "", items: [] };
  const status = taskRunStatusLabel(taskRun, translate);
  const items = taskRunItems(taskRun, translate);
  if (!items.length) return { visible: false, summary: "", items: [] };
  return {
    visible: true,
    summary: translate("task.strip.status", { status }),
    items,
  };
}

function applyCollapsed(strip, header) {
  strip.classList.toggle("is-collapsed", collapsed);
  if (header) header.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const caret = strip.querySelector(".live-task-strip-caret");
  if (caret) caret.textContent = collapsed ? "▸" : "▾";
}

/** Update the pinned strip for the active session's live turn. Pass the live turn
 *  (or null) — when there's no live turn or no to-dos, the strip hides. */
export function renderLiveTaskStrip(liveTurn) {
  const strip = document.getElementById("liveTaskStrip");
  if (!strip) return;
  const header = document.getElementById("liveTaskStripHeader");
  if (!wired && header) {
    wired = true;
    header.addEventListener("click", () => {
      collapsed = !collapsed;
      applyCollapsed(strip, header);
    });
  }

  const model = buildLiveTaskStripModel(liveTurn, t);
  if (!model.visible) {
    strip.hidden = true;
    return;
  }

  const summaryEl = strip.querySelector(".live-task-strip-summary");
  if (summaryEl && summaryEl.textContent !== model.summary) summaryEl.textContent = model.summary;

  const list = strip.querySelector(".live-task-strip-items");
  if (list) {
    list.replaceChildren();
    for (const item of model.items) {
      const li = document.createElement("li");
      li.className = `live-task-item is-${item.status}`;
      const icon = item.status === "completed" ? "✓" : item.status === "in_progress" ? "▸" : item.status === "warning" ? "!" : "○";
      li.textContent = `${icon} ${item.content}`;
      list.appendChild(li);
    }
  }

  strip.hidden = false;
  applyCollapsed(strip, header);
}
