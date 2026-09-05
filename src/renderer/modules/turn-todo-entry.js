import { t } from "../i18n/index.js";
import { parseTodoEntries } from "./turn-tool-model.js";
import { decorateTodoItem, overlayPlanOnTodos, summarizeTodoProgress } from "./todo-progress-overlay.js";

export function renderTodoEntry(entry, {
  isLatest = true,
  parseTodos = parseTodoEntries,
  translate = t,
  taskRun = null,
} = {}) {
  // The sealed card carries the reconciled overlay from record.meta.taskRun,
  // so a list the model never finished still shows what the record proves.
  const todos = overlayPlanOnTodos(parseTodos(entry), isLatest ? taskRun : null);
  if (!todos.length) return null;
  const details = document.createElement("details");
  details.className = "assistant-todo-card";
  details.dataset.toolId = entry.id || "";
  details.open = isLatest;
  const summary = document.createElement("summary");
  summary.className = "assistant-todo-summary";
  summary.textContent = summarizeTodoProgress(todos, isLatest ? taskRun : null, translate);
  details.appendChild(summary);
  const list = document.createElement("ul");
  list.className = "assistant-todo-items";
  renderTodoItems(list, todos, translate);
  details.appendChild(list);
  return details;
}

export function renderTodoItems(list, todos, translate = t) {
  if (!list) return;
  list.replaceChildren();
  for (const todo of todos) {
    const item = document.createElement("li");
    decorateTodoItem(item, todo, translate, "assistant-todo-item");
    list.appendChild(item);
  }
}
