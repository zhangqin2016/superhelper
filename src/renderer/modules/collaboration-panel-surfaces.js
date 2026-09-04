/**
 * The two panel surfaces the centre wires but does not own: the detail screen
 * beside the list, and detaching the panel into its own window.
 *
 * They live together because both are about WHERE the panel is showing rather
 * than what it is showing, and `collaboration-center.js` was at its line
 * ceiling.
 */

/**
 * A detail screen — a roster, a pending-request list — shown beside the list
 * rather than appended into it. Opening one hides the list, so only one of the
 * two is on screen; leaving is the back button, as it is for a conversation.
 */
export function createDetailSurface({ listColumn, view, title, body, back }) {
  const close = () => {
    if (view) view.hidden = true;
    if (listColumn) listColumn.hidden = false;
    if (body) body.replaceChildren();
    if (title) title.textContent = "";
  };
  const open = (label) => {
    if (!view || !body) return null;
    if (title) title.textContent = String(label || "");
    if (listColumn) listColumn.hidden = true;
    view.hidden = false;
    return body;
  };
  back?.addEventListener("click", close);
  return {
    open,
    close,
    destroy() { back?.removeEventListener("click", close); },
  };
}

/**
 * Detaching. The docked panel closes when the window opens, so the same
 * conversation is not shown twice, and the toggle brings it back once the
 * window is gone — which only the main process knows about, so it reports it.
 */
export function createDetachControl({ button, api = () => window.assistantClient?.collaboration, onDetached = () => {}, isDisposed = () => false }) {
  const click = async () => {
    const result = await api()?.detachWindow?.().catch(() => null);
    if (result?.detached) onDetached();
  };
  button?.addEventListener("click", click);
  const unsubscribe = api()?.onWindowState?.((payload) => {
    if (isDisposed() || !button) return;
    // Nothing to restore here: the toggle re-opens the docked panel. This only
    // stops the control claiming a window that has already gone.
    button.setAttribute("aria-pressed", String(payload?.detached === true));
  }) || (() => {});
  return {
    destroy() { button?.removeEventListener("click", click); unsubscribe(); },
  };
}

/** In-conversation search, WeChat-style: hidden behind a header icon rather
 *  than a persistent full-width bar. Returns `{ reset }` to close it on leave.
 *  `onChange` receives the current query (empty string when cleared/closed). */
export function wireConversationHeader({ input, toggle, infoButton, onChange, onInfo } = {}) {
  input?.addEventListener("input", () => onChange(input.value || ""));
  toggle?.addEventListener("click", () => {
    const show = input.hidden;
    input.hidden = !show;
    toggle.setAttribute("aria-expanded", String(show));
    if (show) input.focus?.();
    else { input.value = ""; onChange(""); }
  });
  infoButton?.addEventListener("click", () => onInfo?.());
  return {
    // Group info is only meaningful for a group or channel, never a 1:1.
    setKind(kind) { if (infoButton) infoButton.hidden = !kind || kind === "direct"; },
    reset() { if (input) { input.hidden = true; input.value = ""; } toggle?.setAttribute("aria-expanded", "false"); if (infoButton) infoButton.hidden = true; },
  };
}

/** The group-info drawer: same `{ open(label) -> body, close() }` shape as the
 *  detail surface, but it slides in over the thread's trailing edge instead of
 *  replacing the list — WeChat opens group info beside the conversation. */
export function createDrawerSurface({ view, title, body, close: closeButton }) {
  let returnFocusTo = null;
  const close = () => {
    if (view) view.hidden = true;
    if (body) body.replaceChildren();
    if (title) title.textContent = "";
    const target = returnFocusTo; returnFocusTo = null;
    if (target && document.contains(target)) target.focus?.({ preventScroll: true });
  };
  const open = (label) => {
    if (!view || !body) return null;
    if (!returnFocusTo && document.activeElement instanceof HTMLElement) returnFocusTo = document.activeElement;
    if (title) title.textContent = String(label || "");
    view.hidden = false;
    return body;
  };
  closeButton?.addEventListener("click", close);
  return { open, close, destroy() { closeButton?.removeEventListener("click", close); } };
}
