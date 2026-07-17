import { t } from "../i18n/index.js";
import { normalizeTurnArticleLayout } from "./turn-article-layout.js";
import { renderFooter } from "./turn-footer.js";
import { applyStatusDisplay } from "./turn-status-dom.js";
import { buildStatusText } from "./turn-view-status.js";
import { renderTurnMemoryChip } from "./turn-memory-chip.js";

export function syncTurnArticleFrame(article, liveTurn, viewModel, ctx = {}, {
  normalizeLayout = normalizeTurnArticleLayout,
  refreshStatus = refreshLiveTurnStatusDisplay,
  renderFooterSlot = renderFooter,
} = {}) {
  article.classList.toggle("is-sealed", viewModel.articleClassFlags.isSealed);
  article.classList.toggle("is-live", viewModel.articleClassFlags.isLive);
  article.classList.toggle("is-working", viewModel.articleClassFlags.isWorking);
  // Distinguish terminal outcomes so each reads as a designed state (not just a
  // recolored line): failed (danger), stalled (warning), interrupted-by-you
  // (calm neutral — it was intentional). Styled in runtime-chat.css.
  const finalType = liveTurn.final?.type;
  const terminal = liveTurn.final
    ? ((ctx.failed || finalType === "turn.failed") ? "failed"
      : finalType === "turn.interrupted" ? "interrupted"
        : finalType === "turn.stalled" ? "stalled" : "")
    : "";
  if (terminal) article.dataset.terminal = terminal;
  else delete article.dataset.terminal;
  normalizeLayout(article, viewModel.slotOrder);
  refreshStatus(article, liveTurn, ctx);
  renderFooterSlot(article.querySelector('[data-role="footer"]'), liveTurn, ctx.sealed);
}

export function refreshLiveTurnStatusDisplay(article, liveTurn, ctx = {}, {
  buildStatus = buildStatusText,
  applyStatus = applyStatusDisplay,
  translate = t,
} = {}) {
  if (!article || !liveTurn) return;
  const failed = Boolean(ctx.failed);
  const sealed = Boolean(liveTurn.final) || Boolean(ctx.sealed);
  const status = article.querySelector('[data-role="status"]');
  const header = article.querySelector('[data-role="header"]');
  if (status) {
    const text = buildStatus(liveTurn, { failed, sealed }, translate);
    applyStatus(status, text, { sealed: sealed && Boolean(liveTurn.final), live: !sealed });
  }
  // Memory-usage chip: reflects which memories the turn used (sealed turns only).
  let memoryChip = null;
  try {
    memoryChip = renderTurnMemoryChip(header, liveTurn);
  } catch {
    memoryChip = null;
  }
  if (header) header.hidden = !status?.textContent && !memoryChip;
}
