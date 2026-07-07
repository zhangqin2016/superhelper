import { enhanceFileMentions } from "./file-mentions.js";
import { renderNarrative } from "./turn-narrative-renderer.js";

export function renderTurnNarrativeSlot(article, liveTurn, viewModel, {
  sealed = false,
  sessionId = "",
  renderNarrativeSlot = renderNarrative,
  enhanceMentions = enhanceFileMentions,
} = {}) {
  const narrativeKey = viewModel.narrative.key;
  if (article.dataset.narrativeKey === narrativeKey) return;
  const narrativeEl = article.querySelector('[data-role="narrative"]');
  renderNarrativeSlot(narrativeEl, liveTurn, { sealed, narrative: viewModel.narrative });
  if (sealed) {
    enhanceMentions(narrativeEl, sessionId, viewModel.artifacts.resultBlocks);
  }
  article.dataset.narrativeKey = narrativeKey;
}
