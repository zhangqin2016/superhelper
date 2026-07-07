import { renderStreamingMarkdown, renderMarkdownFinal } from "./markdown.js";

const narrativeRenderState = new Map();

export function forgetNarrativeMarkdownTurn(turnId) {
  if (turnId) narrativeRenderState.delete(turnId);
}

export function scheduleNarrativeMarkdown(textEl, text, turnId, {
  sealed = false,
  renderStreaming = renderStreamingMarkdown,
  renderFinal = renderMarkdownFinal,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  delayMs = 120,
} = {}) {
  if (!textEl || !turnId) return;
  const key = turnId;
  let state = narrativeRenderState.get(key);
  if (!state) {
    state = { timer: null, pending: text };
    narrativeRenderState.set(key, state);
  } else {
    state.pending = text;
  }

  if (sealed) {
    // Sealing must upgrade to the full render even when text matches the stream,
    // so live and history turns render the same finished markdown.
    if (textEl.dataset.renderMode === "full" && textEl.dataset.streamText === text) return;
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = null;
    }
    renderFinal(textEl, text);
    textEl.dataset.streamText = text;
    textEl.dataset.renderMode = "full";
    return;
  }

  if (textEl.dataset.streamText === text) return;

  if (!textEl.dataset.streamText) {
    renderStreaming(textEl, text);
    textEl.dataset.streamText = text;
    textEl.dataset.renderMode = "stream";
    return;
  }

  if (state.timer) return;
  state.timer = setTimeoutFn(() => {
    state.timer = null;
    const next = state.pending || "";
    if (!next || textEl.dataset.streamText === next) return;
    renderStreaming(textEl, next);
    textEl.dataset.streamText = next;
    textEl.dataset.renderMode = "stream";
  }, delayMs);
}
