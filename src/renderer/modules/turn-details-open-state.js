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
  // A folded group builds its content when opened; build the ones that will
  // reopen first, so the items inside them can have their state restored too.
  // Repeats while opening a group reveals further groups to reopen.
  for (let pass = 0; pass < 8; pass += 1) {
    let built = false;
    for (const details of root.querySelectorAll("details")) {
      if (typeof details.__ensureContent !== "function" || details.__contentBuilt) continue;
      if (openState.get(detailsOpenStateKey(details)) !== true) continue;
      details.__ensureContent();
      built = true;
    }
    if (!built) break;
  }
  for (const details of root.querySelectorAll("details")) {
    if (collapseFinishedThinking && details.classList.contains("assistant-process-thinking-group")) {
      details.open = false;
      continue;
    }
    const key = detailsOpenStateKey(details);
    if (openState.has(key)) details.open = openState.get(key);
  }
}
