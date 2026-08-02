import { renderResultBlocks } from "./turn-block-renderers.js";
import { appendHoistedGeneratedMedia } from "./turn-hoisted-media.js";

export function renderTurnArtifacts(article, artifacts = {}, {
  sessionId = "",
  renderResults = renderResultBlocks,
  appendHoisted = appendHoistedGeneratedMedia,
} = {}) {
  renderResults(
    article.querySelector('[data-role="artifacts"]'),
    artifacts.visibleResultBlocks || [],
    { sessionId },
  );
  appendHoisted(article, artifacts.hoistedMediaGroups || [], { sessionId });
}
