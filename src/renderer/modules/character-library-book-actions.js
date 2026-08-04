/** World-book-specific conversation actions kept out of the main library controller. */

export async function removeWorldBookFromConversation({
  facade,
  getState,
  getActiveSessionId,
  dispatch,
  setNotice,
  openDetail,
}, item) {
  const api = facade();
  const sessionId = getActiveSessionId?.();
  if (!api || !sessionId || !item || getState().activation.status === "running") return;
  const current = await api.getSessionCharacterBinding(sessionId);
  if (!current?.ok || !Number.isInteger(current.binding?.bindingVersion)) {
    setNotice("action_failed");
    return;
  }
  dispatch({ type: "activation.started", itemId: item.id });
  try {
    const res = await api.activateLibraryItem({
      sessionId,
      kind: "worldBook",
      revisionId: item.currentRevisionId,
      action: "remove",
      expectedBindingVersion: current.binding.bindingVersion,
    });
    if (res?.ok) {
      dispatch({ type: "activation.settled", itemId: item.id });
      setNotice("removed", { name: item.name });
      await openDetail(item);
    } else {
      dispatch({ type: "activation.failed", itemId: item.id, error: res?.error || "ACTIVATION_FAILED" });
      setNotice(res?.error === "CHARACTER_BINDING_CONFLICT" ? "conflict" : "action_failed");
    }
  } catch {
    dispatch({ type: "activation.failed", itemId: item.id, error: "ACTIVATION_FAILED" });
    setNotice("action_failed");
  }
}
