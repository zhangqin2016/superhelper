import { t } from "../i18n/index.js";
import {
  finalReportView,
  renderFinalReport,
} from "./turn-final-report.js";
import { forgetNarrativeMarkdownTurn } from "./turn-narrative-markdown.js";

export function renderFinal(article, liveTurn, narrative = null, {
  translate = t,
  makeView = finalReportView,
  forgetMarkdown = forgetNarrativeMarkdownTurn,
  renderReport = renderFinalReport,
} = {}) {
  const view = makeView(liveTurn, narrative, {
    hasExistingReport: Boolean(article.querySelector(".assistant-turn-report")),
    sealed: article.classList.contains("is-sealed"),
    translate,
  });
  if (!view) return;
  forgetMarkdown(liveTurn.turnId);
  renderReport(article, view);
}
