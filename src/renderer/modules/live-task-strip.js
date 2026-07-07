// Pinned, collapsible task strip just above the composer. During a LIVE turn it
// shows the agent's current to-do list (the progress anchor for long tasks) so it
// never scrolls away — answering the "is it still working / how much is left?"
// question. Sealed/history turns keep their inline card (turn-view-renderer skips
// the inline card only while live, so there's no duplication).
import { isTodoTool, parseTodoEntries } from "./turn-tool-model.js";
import { t } from "../i18n/index.js";

let collapsed = false;
let wired = false;

function latestTodos(liveTurn) {
  const tools = liveTurn?.tools;
  if (!tools) return [];
  const values = tools instanceof Map ? [...tools.values()] : tools;
  let latest = null;
  for (const tool of values) if (isTodoTool(tool?.name)) latest = tool;
  return latest ? applyActiveTaskStep(parseTodoEntries(latest), liveTurn?.taskRun) : [];
}

function applyActiveTaskStep(todos = [], taskRun = null) {
  if (!todos.length || todos.some((todo) => todo.status === "in_progress")) return todos;
  const plan = Array.isArray(taskRun?.plan) ? taskRun.plan : [];
  const activeId = String(taskRun?.activeStep || "");
  const activeIndex = plan.findIndex((step) => String(step?.id || "") === activeId);
  if (activeIndex < 0 || activeIndex >= todos.length) return todos;
  return todos.map((todo, index) => (
    index === activeIndex && todo.status !== "completed"
      ? { ...todo, status: "in_progress" }
      : todo
  ));
}

export function buildLiveTaskStripModel(liveTurn, translate = t) {
  if (!liveTurn || liveTurn.final) return { visible: false, summary: "", items: [] };
  const todos = latestTodos(liveTurn);
  if (todos.length) {
    const done = todos.filter((todo) => todo.status === "completed").length;
    const inProgress = todos.find((todo) => todo.status === "in_progress");
    let summary = translate("todo.summary", { done, total: todos.length });
    if (inProgress) summary += ` · ${translate("task.strip.current", { item: inProgress.content })}`;
    return { visible: true, summary, items: todos };
  }
  return { visible: false, summary: "", items: [] };
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
