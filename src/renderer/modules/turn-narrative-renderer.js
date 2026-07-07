import { buildTurnViewModel } from "./turn-view-model.js";
import {
  forgetNarrativeMarkdownTurn,
  scheduleNarrativeMarkdown,
} from "./turn-narrative-markdown.js";
import { syncNarrativeImages } from "./turn-narrative-images.js";

export function renderNarrative(root, liveTurn, { sealed = false, narrative = null } = {}, {
  buildView = buildTurnViewModel,
  scheduleMarkdown = scheduleNarrativeMarkdown,
  forgetMarkdown = forgetNarrativeMarkdownTurn,
  syncImages = syncNarrativeImages,
} = {}) {
  if (!root) return;
  const view = narrative || buildView(liveTurn, { sealed }).narrative;
  const text = view.text || "";
  root.hidden = !view.visible;
  if (root.hidden) {
    root.replaceChildren();
    delete root.dataset.imageKey;
    return;
  }

  let textEl = root.querySelector(".assistant-turn-narrative-text");
  if (text) {
    if (!textEl) {
      textEl = document.createElement("div");
      textEl.className = "assistant-turn-narrative-text markdown-body";
      root.prepend(textEl);
    }
    scheduleMarkdown(textEl, text, liveTurn.turnId || "live", { sealed });
  } else if (textEl) {
    textEl.remove();
    forgetMarkdown(liveTurn.turnId);
  }

  syncImages(root, view.inlineImages || [], view.inlineImageKey || "");
}
