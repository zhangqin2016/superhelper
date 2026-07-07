import {
  getRenderableTimeline,
} from "./turn-renderable-timeline.js";
import {
  buildTurnViewModel,
} from "./turn-view-model.js";
import {
  refreshLiveTurnStatusDisplay,
  syncTurnArticleFrame,
} from "./turn-article-frame.js";
import { renderTurnArticleSlots } from "./turn-article-slots.js";
import { createLiveTurnArticleShell } from "./turn-article-shell.js";

export {
  legacyLiveTurnFromMessage,
  liveTurnFromRecord,
} from "./turn-view-model.js";
export { createLiveTurnArticleShell } from "./turn-article-shell.js";
export { refreshLiveTurnStatusDisplay } from "./turn-article-frame.js";

export function renderLiveTurnArticle(article, liveTurn, ctx = {}) {
  const { sessionId, failed = false } = ctx;
  const sealed = Boolean(liveTurn.final) || ctx.sealed;
  // Snapshot generated media from the tool results BEFORE renderProcess drains
  // liveTurn.tools; the DOM is appended at the end (renderResultBlocks clears the
  // artifacts host, so appending earlier would be wiped).
  const viewModel = buildTurnViewModel(liveTurn, { sealed });
  syncTurnArticleFrame(article, liveTurn, viewModel, { failed, sealed });
  renderTurnArticleSlots(article, liveTurn, viewModel, { sessionId, sealed });
}

export function renderSealedTurnArticle(liveTurn, failed = false) {
  const article = createLiveTurnArticleShell(liveTurn);
  article.className = "assistant-turn-article is-sealed";
  if (failed) article.dataset.failed = "true";
  renderLiveTurnArticle(article, liveTurn, { failed, sealed: true });
  return article;
}
