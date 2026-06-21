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

  const todos = liveTurn && !liveTurn.final ? latestTodos(liveTurn) : [];
  if (!todos.length) {
    strip.hidden = true;
    return;
  }

  const done = todos.filter((todo) => todo.status === "completed").length;
  const inProgress = todos.find((todo) => todo.status === "in_progress");
  let summary = t("todo.summary", { done, total: todos.length });
  if (inProgress) summary += ` · ${t("task.strip.current", { item: inProgress.content })}`;
  const summaryEl = strip.querySelector(".live-task-strip-summary");
  if (summaryEl && summaryEl.textContent !== summary) summaryEl.textContent = summary;

  const list = strip.querySelector(".live-task-strip-items");
  if (list) {
    list.replaceChildren();
    for (const todo of todos) {
      const li = document.createElement("li");
      li.className = `live-task-item is-${todo.status}`;
      const icon = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○";
      li.textContent = `${icon} ${todo.content}`;
      list.appendChild(li);
    }
  }

  strip.hidden = false;
  applyCollapsed(strip, header);
}
