/**
 * A <details> whose content is built the first time it is opened.
 *
 * A finished turn folds its steps into "已完成 N 步". Once every step is kept
 * (the archived timeline is no longer cut to its last 100 entries), a page of
 * long turns can hold thousands of step rows — all built into bodies nobody
 * has opened, on every session switch. Content that cannot be seen is not
 * built until it can.
 *
 * `ensureDetailsContent` builds it on demand for code that needs the inner
 * nodes now, such as restoring which inner items were open.
 */
export function lazyDetails(details, build) {
  const ensure = () => {
    if (details.__contentBuilt) return;
    details.__contentBuilt = true;
    build();
  };
  details.__ensureContent = ensure;
  details.addEventListener?.("toggle", () => { if (details.open) ensure(); });
  if (details.open) ensure();
  return details;
}

export function ensureDetailsContent(details) {
  if (typeof details?.__ensureContent === "function") details.__ensureContent();
}
