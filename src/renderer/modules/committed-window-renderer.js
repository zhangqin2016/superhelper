import { messageKey } from "./message-render-keys.js";

const jobs = new WeakMap();

function articles(listEl) {
  return [...listEl.children].filter((node) => node.dataset.messageKey);
}

export function isCommittedDomOrderCurrent(listEl, messages = []) {
  if (!listEl) return false;
  const nodes = articles(listEl);
  return nodes.length === messages.length && nodes.every(
    (node, index) => node.dataset.messageKey === messageKey(messages[index], index),
  );
}

// Move only out-of-order nodes. Existing article identity (expanded cards,
// selection and listeners) survives reconciliation; live articles are unkeyed.
function reconcileOrder(listEl, entries, anchor) {
  const byKey = new Map(articles(listEl).map((node) => [node.dataset.messageKey, node]));
  let next = anchor?.parentNode === listEl ? anchor : null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const node = byKey.get(entries[index].key);
    if (!node) continue;
    // Unkeyed completed live answers may still sit between turns until their
    // sealed copy arrives. Preserve those slots; only repair relative order.
    if (next && !(node.compareDocumentPosition(next) & 4)) listEl.insertBefore(node, next);
    next = node;
  }
}

export function renderCommittedWindow({
  listEl, messages, keys, append, anchor, schedule, isCurrent,
  chunkSize, allowEvict = false, onComplete = null, skip = () => false,
}) {
  const previous = jobs.get(listEl);
  const callbacks = previous?.isCurrent() ? previous.callbacks : new Set();
  if (onComplete) callbacks.add(onComplete);
  const wanted = new Set();
  const entries = messages.map((message, index) => ({ message, key: messageKey(message, index) }))
    .filter(({ message, key }) => {
      if (skip(message) || wanted.has(key)) return false;
      wanted.add(key);
      return true;
    });
  // Keys describe mounted articles, never reservations for future frames.
  keys.clear();
  for (const node of articles(listEl)) {
    if (allowEvict && !wanted.has(node.dataset.messageKey)) node.remove();
    else keys.add(node.dataset.messageKey);
  }
  const pending = entries.filter((entry) => !keys.has(entry.key));
  const job = { callbacks, isCurrent };
  jobs.set(listEl, job);
  let cursor = 0;
  const pump = () => {
    if (jobs.get(listEl) !== job || !isCurrent()) return;
    const end = Math.min(cursor + chunkSize, pending.length);
    for (; cursor < end; cursor += 1) {
      const { message, key } = pending[cursor];
      if (!keys.has(key)) append(message, key);
    }
    keys.clear();
    for (const node of articles(listEl)) keys.add(node.dataset.messageKey);
    reconcileOrder(listEl, entries, anchor());
    if (cursor < pending.length) schedule(pump);
    else {
      jobs.delete(listEl);
      for (const callback of callbacks) callback();
    }
  };
  pump();
  return pending.length;
}
