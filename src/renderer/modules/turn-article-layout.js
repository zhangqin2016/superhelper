export function normalizeTurnArticleLayout(article, slotOrder = []) {
  const header = article.querySelector('[data-role="header"]');
  const narrative = article.querySelector('[data-role="narrative"]');
  const process = article.querySelector('[data-role="process"]');
  let taskRun = article.querySelector('[data-role="taskrun"]');
  let artifacts = article.querySelector('[data-role="artifacts"]');
  const footer = article.querySelector('[data-role="footer"]');
  const prompts = article.querySelector('[data-role="prompts"]');
  if (!taskRun) {
    taskRun = document.createElement("div");
    taskRun.className = "assistant-turn-taskrun";
    taskRun.dataset.role = "taskrun";
    taskRun.hidden = true;
  }
  if (!artifacts) {
    artifacts = document.createElement("div");
    artifacts.className = "assistant-turn-artifacts";
    artifacts.dataset.role = "artifacts";
    artifacts.hidden = true;
  }
  if (!header || !narrative || !process || !footer || !prompts) return;

  // Same region order whether live or sealed: process (work) above, answer below.
  const roleNodes = { header, process, taskrun: taskRun, narrative, artifacts, footer, prompts };
  const desiredRoles = Array.isArray(slotOrder) && slotOrder.length ? slotOrder : Object.keys(roleNodes);
  const desired = desiredRoles.map((role) => roleNodes[role]).filter(Boolean);
  if (desired.length !== Object.keys(roleNodes).length) return;
  // Idempotent: only touch DOM when order is wrong, avoiding streamed markdown/image flicker.
  // Compare role-bearing children only — the speaker row (no data-role) sits first and stays out of scope.
  const current = Array.from(article.children).filter((node) => node.dataset?.role);
  const sameOrder = current.length === desired.length && desired.every((n, i) => current[i] === n);
  if (!sameOrder) article.append(...desired);
}
