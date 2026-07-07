import { t } from "../i18n/index.js";
import { taskRunSummaryForView } from "./turn-view-status.js";

export function renderTaskRunSummary(root, liveTurn, sealed, {
  translate = t,
  summarizeTaskRun = taskRunSummaryForView,
} = {}) {
  if (!root) return;
  try {
    const taskRun = liveTurn?.taskRun || liveTurn?.final?.payload?.record?.meta?.taskRun || null;
    const summary = sealed ? summarizeTaskRun(taskRun, translate) : "";
    if (!summary) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    let details = root.querySelector(".assistant-taskrun-summary");
    if (!details) {
      details = document.createElement("details");
      details.className = "assistant-taskrun-summary";
      const summaryEl = document.createElement("summary");
      summaryEl.className = "assistant-taskrun-summary-title";
      details.appendChild(summaryEl);
      const body = document.createElement("div");
      body.className = "assistant-taskrun-summary-body";
      details.appendChild(body);
      root.replaceChildren(details);
    }
    const summaryEl = details.querySelector(".assistant-taskrun-summary-title");
    const body = details.querySelector(".assistant-taskrun-summary-body");
    if (summaryEl) summaryEl.textContent = translate("task.summary.title");
    if (body && body.textContent !== summary) body.textContent = summary;
    root.hidden = false;
  } catch {
    root.hidden = true;
    root.replaceChildren();
  }
}
