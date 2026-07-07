import { shouldShowFinal } from "./turn-narrative-policy.js";
import { renderMarkdownContent } from "./content-blocks.js";
import { renderStreamingMarkdown, renderMarkdownFinal } from "./markdown.js";

export function finalReportView(liveTurn, narrative = null, {
  hasExistingReport = false,
  sealed = false,
  translate,
} = {}) {
  if (hasExistingReport) return null;
  if (!shouldShowFinal(liveTurn)) return null;
  return {
    label: translate("message.resultLabel"),
    text: narrative?.text || "",
    sealed: Boolean(sealed),
  };
}

export function renderFinalReport(article, view, {
  renderStreaming = renderStreamingMarkdown,
  renderFinal = renderMarkdownFinal,
  renderContent = renderMarkdownContent,
  requestIdle = globalThis.requestIdleCallback,
  setTimeoutFn = setTimeout,
} = {}) {
  const report = document.createElement("section");
  report.className = "assistant-turn-report";

  const label = document.createElement("p");
  label.className = "assistant-turn-report-label";
  label.textContent = view.label;

  const final = document.createElement("div");
  final.className = "assistant-turn-final markdown-body assistant-turn-report-body";
  if (view.sealed) {
    renderStreaming(final, view.text);
    const upgrade = () => { renderFinal(final, view.text); };
    if (typeof requestIdle === "function") requestIdle(upgrade);
    else setTimeoutFn(upgrade, 200);
  } else {
    renderContent(final, view.text);
  }

  report.append(label, final);
  const artifacts = article.querySelector('[data-role="artifacts"]');
  if (artifacts) article.insertBefore(report, artifacts);
  else article.appendChild(report);
  return report;
}
