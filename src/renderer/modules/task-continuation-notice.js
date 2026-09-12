// Platform status, not an assistant completion: no duration, completion footer,
// generic retry or rewind controls (those operate on the latest user turn).
export function appendTaskContinuationNotice(listEl, message, beforeNode = null, key = "") {
  if (!listEl) return;
  const article = document.createElement("article");
  article.className = "task-continuation-notice assistant-process-notice is-warning";
  article.setAttribute("role", "status");
  if (key) article.dataset.messageKey = key;
  article.textContent = message.content || "";
  if (beforeNode && listEl.contains(beforeNode)) listEl.insertBefore(article, beforeNode);
  else listEl.appendChild(article);
}
