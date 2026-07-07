import {
  hookCard,
  permissionCard,
  planApprovalCard,
} from "./turn-action-prompt-cards.js";
import { questionCard } from "./turn-question-card.js";
import { renderPrompts } from "./turn-prompts-renderer.js";

export const promptRenderers = {
  question: questionCard,
  hook: hookCard,
  plan: planApprovalCard,
  permission: permissionCard,
};

export function renderTurnPromptsSlot(article, sessionId, liveTurn, viewModel, {
  renderPromptRoot = renderPrompts,
  renderers = promptRenderers,
} = {}) {
  if (!sessionId) return;
  renderPromptRoot(article.querySelector('[data-role="prompts"]'), sessionId, liveTurn, viewModel.prompts, {
    renderers,
  });
}
