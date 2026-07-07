export function detailsOpenStateKey(details) {
  if (details.dataset.toolId) return details.dataset.toolId;
  if (details.dataset.thinkingId) return `thinking:${details.dataset.thinkingId}`;
  return details.className;
}

export function collectDetailsOpenState(root) {
  const map = new Map();
  for (const details of root.querySelectorAll("details")) {
    map.set(detailsOpenStateKey(details), details.open);
  }
  return map;
}

export function restoreDetailsOpenState(root, openState, { collapseFinishedThinking = false } = {}) {
  for (const details of root.querySelectorAll("details")) {
    if (collapseFinishedThinking && details.classList.contains("assistant-process-thinking-group")) {
      details.open = false;
      continue;
    }
    const key = detailsOpenStateKey(details);
    if (openState.has(key)) details.open = openState.get(key);
  }
}
