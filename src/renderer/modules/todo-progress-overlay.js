// Plan-progress overlay: merges the platform's execution-evidence view
// (taskRun.plan[i].inferred / planSync, computed in the main process) onto the
// model's own todo list for display. The model's statuses stay authoritative;
// the overlay adds what the record proves and says honestly when the list is
// stale — so the card can be "evidenced but unconfirmed" instead of
// confidently wrong. Pure functions; safe on partial or missing input.

export function overlayPlanOnTodos(todos = [], taskRun = null) {
  const items = Array.isArray(todos) ? todos : [];
  const plan = Array.isArray(taskRun?.plan) ? taskRun.plan : [];
  const aligned = plan.length === items.length && plan.every((step) => String(step?.id || "").startsWith("todo_"));
  if (!aligned) return items.map((todo) => ({ ...todo, inferred: null, evidence: null }));
  return items.map((todo, index) => {
    const step = plan[index] || {};
    const inferred = todo.status === "completed" ? null : (step.inferred || null);
    return { ...todo, inferred, evidence: inferred ? (step.evidence || null) : null };
  });
}

/** Display state per item — one of the model statuses or an overlay state. */
export function todoDisplayStatus(item = {}) {
  if (item.status === "completed") return "completed";
  if (item.inferred === "evidenced" || item.inferred === "model_completed") return "evidenced";
  if (item.inferred === "unconfirmed") return "unconfirmed";
  if (item.status === "in_progress" || item.inferred === "active") return "in_progress";
  if (item.status === "warning") return "warning";
  return "pending";
}

export function todoIcon(display) {
  switch (display) {
    case "completed": return "✓";
    case "evidenced": return "✓";
    case "in_progress": return "▸";
    case "unconfirmed": return "?";
    case "warning": return "!";
    default: return "○";
  }
}

/** Tooltip key for overlay states (null when the model's own status speaks). */
export function todoTitleKey(item = {}) {
  const display = todoDisplayStatus(item);
  if (display === "evidenced") return item.inferred === "model_completed" ? "todo.modelCompletedTitle" : "todo.evidencedTitle";
  if (display === "unconfirmed") return "todo.unconfirmedTitle";
  return null;
}

/** Summary line: confirmed count, evidence-only count, current item, staleness. */
export function summarizeTodoProgress(items = [], taskRun = null, translate = (key) => key) {
  const list = Array.isArray(items) ? items : [];
  const done = list.filter((item) => item.status === "completed").length;
  const evidenced = list.filter((item) => todoDisplayStatus(item) === "evidenced").length;
  const unconfirmed = list.filter((item) => todoDisplayStatus(item) === "unconfirmed").length;
  const current = list.find((item) => todoDisplayStatus(item) === "in_progress");
  const parts = [translate("todo.summary", { done, total: list.length })];
  if (evidenced) parts.push(translate("todo.evidenced", { count: evidenced }));
  if (unconfirmed) parts.push(translate("todo.unconfirmed", { count: unconfirmed }));
  if (current) parts.push(translate("task.strip.current", { item: current.content }));
  const since = Number(taskRun?.planSync?.toolsSinceTodo || 0);
  if (taskRun?.planSync?.stale && since >= 2) parts.push(translate("todo.stale", { steps: since }));
  return parts.join(" · ");
}

/** Apply the overlay to a DOM <li>: class, icon, tooltip. */
export function decorateTodoItem(li, item, translate = (key) => key, baseClass = "assistant-todo-item") {
  const display = todoDisplayStatus(item);
  li.className = `${baseClass} is-${display}${item.inferred ? ` is-inferred-${item.inferred}` : ""}`;
  li.textContent = `${todoIcon(display)} ${item.content}`;
  const titleKey = todoTitleKey(item);
  if (titleKey) {
    const snippet = item.evidence?.snippet ? ` — ${item.evidence.snippet}` : "";
    li.title = `${translate(titleKey)}${snippet}`;
  }
}
