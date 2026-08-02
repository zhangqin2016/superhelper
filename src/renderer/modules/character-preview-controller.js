import { renderCharacterPreviewBanner } from "./character-preview-banner.js";

export function createCharacterPreviewController({ getState, dispatch, getFacade, getElement, refreshBinding }) {
  async function load(sessionId) {
    const seq = getState().loadSeq;
    const api = getFacade();
    if (!api) return;
    dispatch({ type: "preview.loading", sessionId, seq });
    try {
      const result = await api.getPreview(sessionId);
      dispatch(result?.ok
        ? { type: "preview.loaded", sessionId, seq, preview: result.preview }
        : { type: "preview.conflict", sessionId, seq, error: result?.error });
    } catch {
      dispatch({ type: "preview.conflict", sessionId, seq, error: "unavailable" });
    }
  }

  async function activate() {
    const { sessionId, preview } = getState();
    if (!sessionId || !preview?.activation) return;
    const result = await getFacade()?.activatePreview({
      sessionId, receiptId: preview.activation.receiptId,
      actionToken: preview.activation.actionToken,
      expectedPreviewVersion: preview.previewVersion,
      expectedBindingVersion: preview.bindingVersion,
    });
    if (result?.ok) await Promise.all([refreshBinding(sessionId), load(sessionId)]);
    else dispatch({ type: "preview.conflict", sessionId, seq: getState().loadSeq, error: result?.error });
  }

  async function exit() {
    const { sessionId, preview } = getState();
    if (!sessionId) return;
    const result = await getFacade()?.exitPreview(sessionId, preview.previewVersion);
    if (result?.ok) await load(sessionId);
    else dispatch({ type: "preview.conflict", sessionId, seq: getState().loadSeq, error: result?.error });
  }

  function render() {
    const host = getElement("characterPreviewBanner");
    if (!host) return;
    const banner = renderCharacterPreviewBanner(getState().preview, {
      onActivate: () => void activate(), onExit: () => void exit(),
    });
    host.replaceChildren(...banner.childNodes);
    host.className = banner.className;
    host.hidden = banner.hidden;
  }

  function bind() {
    window.addEventListener("character-worlds:preview-changed", () => {
      if (getState().sessionId) void load(getState().sessionId);
    });
    window.addEventListener("character-worlds:adjust", (event) => {
      const input = getElement("promptInput");
      const handle = event.detail?.handle;
      if (!input || typeof handle !== "string" || !handle) return;
      input.dataset.characterWorldsAdjustmentHandle = handle;
      input.focus();
    });
  }

  return { bind, load, render };
}
