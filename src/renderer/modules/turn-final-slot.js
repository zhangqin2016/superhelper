import { renderFinal } from "./turn-final-renderer.js";

export function renderTurnFinalSlot(article, liveTurn, narrative = null, {
  renderFinalReport = renderFinal,
} = {}) {
  if (!liveTurn.final || liveTurn.finalRendered) return;
  renderFinalReport(article, liveTurn, narrative);
  liveTurn.finalRendered = true;
}
