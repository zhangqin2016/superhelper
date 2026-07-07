import { t } from "../i18n/index.js";
import { parseTodoEntries } from "./turn-tool-model.js";

export function renderTodoEntry(entry, {
  isLatest = true,
  parseTodos = parseTodoEntries,
  translate = t,
} = {}) {
  const todos = parseTodos(entry);
  if (!todos.length) return null;
  const details = document.createElement("details");
  details.className = "assistant-todo-card";
  details.dataset.toolId = entry.id || "";
  details.open = isLatest;
  const summary = document.createElement("summary");
  summary.className = "assistant-todo-summary";
  const done = todos.filter((todo) => todo.status === "completed").length;
  summary.textContent = translate("todo.summary", { done, total: todos.length });
  details.appendChild(summary);
  const list = document.createElement("ul");
  list.className = "assistant-todo-items";
  renderTodoItems(list, todos);
  details.appendChild(list);
  return details;
}

export function renderTodoItems(list, todos) {
  if (!list) return;
  list.replaceChildren();
  for (const todo of todos) {
    const item = document.createElement("li");
    item.className = `assistant-todo-item is-${todo.status}`;
    const icon = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○";
    item.textContent = `${icon} ${todo.content}`;
    list.appendChild(item);
  }
}
