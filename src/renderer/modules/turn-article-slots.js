import { renderTurnArtifacts } from "./turn-artifacts-renderer.js";
import { renderTurnFinalSlot } from "./turn-final-slot.js";
import { renderTurnNarrativeSlot } from "./turn-narrative-slot.js";
import { renderProcess } from "./turn-process-renderer.js";
import { renderTurnPromptsSlot } from "./turn-prompts-slot.js";
import { renderTaskRunSummary } from "./turn-taskrun-summary.js";

export function renderTurnArticleSlots(
  article,
  liveTurn,
  viewModel,
  {
    sessionId = "",
    sealed = false,
  } = {},
  {
    renderNarrativeSlot = renderTurnNarrativeSlot,
    renderProcessSlot = renderProcess,
    renderTaskRun = renderTaskRunSummary,
    renderPromptsSlot = renderTurnPromptsSlot,
    renderFinalSlot = renderTurnFinalSlot,
    renderArtifactsSlot = renderTurnArtifacts,
  } = {},
) {
  renderNarrativeSlot(article, liveTurn, viewModel, { sealed, sessionId });
  renderProcessSlot(article.querySelector('[data-role="process"]'), liveTurn, {
    sessionId,
    sealed,
  });
  renderTaskRun(article.querySelector('[data-role="taskrun"]'), liveTurn, sealed);
  renderPromptsSlot(article, sessionId, liveTurn, viewModel);
  renderFinalSlot(article, liveTurn, viewModel.narrative);
  renderArtifactsSlot(article, viewModel.artifacts, { sessionId });
}
