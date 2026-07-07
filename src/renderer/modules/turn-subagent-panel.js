import { t } from "../i18n/index.js";
import { toolPreview as defaultToolPreview } from "./turn-tool-preview.js";
import { normalizeToolResult } from "./tool-payload-renderer.js";
import {
  subagentCurrentToolForView,
  subagentDescriptionForView,
  subagentLabelForView,
  subagentMetadataLineForView,
  subagentPanelOpenForView,
  subagentPanelSummaryForView,
  subagentPhaseLabelForView,
  subagentStatsLineForView,
  subagentStatusTextForView,
  subagentTranscriptTextForView,
} from "./turn-view-status.js";

export function renderSubagentStatusPanel(entries = [], sealed = false, {
  translate = t,
  summary = (items) => subagentPanelSummaryForView(items, translate),
  isOpen = (items, isSealed) => subagentPanelOpenForView(items, isSealed),
  label = (entry) => subagentLabelForView(entry, translate),
  description = (entry) => subagentDescriptionForView(entry, translate),
  statusText = (entry) => subagentStatusTextForView(entry, translate),
  phaseLabel = (sub, fallbackStatus) => subagentPhaseLabelForView(sub, fallbackStatus, translate),
  metadata = (entry) => subagentMetadataLineForView(entry, translate),
  stats = (entry) => subagentStatsLineForView(entry, translate),
  currentTool = subagentCurrentToolForView,
  toolPreview = defaultToolPreview,
  normalizeResult = normalizeToolResult,
  transcriptText = (sub) => subagentTranscriptTextForView(sub, translate),
} = {}) {
  if (!entries.length) return null;
  const details = document.createElement("details");
  details.className = "assistant-subagent-panel";
  details.open = isOpen(entries, sealed);
  const summaryEl = document.createElement("summary");
  summaryEl.className = "assistant-subagent-panel-summary";
  summaryEl.textContent = summary(entries);
  details.appendChild(summaryEl);

  const list = document.createElement("div");
  list.className = "assistant-subagent-list";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "assistant-subagent-row";
    row.dataset.status = entry.status || "";

    const head = document.createElement("div");
    head.className = "assistant-subagent-row-head";
    const title = document.createElement("div");
    title.className = "assistant-subagent-title";
    title.textContent = `${label(entry)} · ${description(entry)}`;
    const status = document.createElement("div");
    status.className = "assistant-subagent-status";
    status.textContent = statusText(entry);
    head.append(title, status);
    row.appendChild(head);

    const phase = document.createElement("div");
    phase.className = "assistant-subagent-phase";
    const phaseLabelEl = document.createElement("span");
    phaseLabelEl.className = "assistant-subagent-phase-label";
    phaseLabelEl.textContent = phaseLabel(entry.subagent || {}, entry.status);
    phase.appendChild(phaseLabelEl);
    const phaseDetail = String(entry.subagent?.phaseDetail || "").trim();
    if (phaseDetail) {
      const detail = document.createElement("span");
      detail.className = "assistant-subagent-phase-detail";
      detail.textContent = phaseDetail;
      phase.appendChild(detail);
    }
    row.appendChild(phase);

    const meta = metadata(entry);
    if (meta) {
      const metaEl = document.createElement("div");
      metaEl.className = "assistant-subagent-meta";
      metaEl.textContent = meta;
      row.appendChild(metaEl);
    }

    const statText = stats(entry);
    if (statText) {
      const statsEl = document.createElement("div");
      statsEl.className = "assistant-subagent-stats";
      statsEl.textContent = statText;
      row.appendChild(statsEl);
    }

    const current = currentTool(entry);
    if (current?.name) {
      const currentEl = document.createElement("div");
      currentEl.className = "assistant-subagent-current";
      currentEl.textContent = translate("subagent.currentTool", {
        tool: current.name,
        detail: toolPreview({ name: current.name, input: current.input || {}, partialJson: "" }),
      });
      row.appendChild(currentEl);
    }

    const previewText = entry.subagent?.textPreview || "";
    if (previewText && entry.status === "running") {
      const textEl = document.createElement("div");
      textEl.className = "assistant-subagent-preview";
      textEl.textContent = previewText;
      row.appendChild(textEl);
    }

    const result = normalizeResult(entry.result);
    if (result?.content && entry.status !== "running") {
      const pre = document.createElement("pre");
      pre.className = "assistant-subagent-result";
      pre.textContent = result.content;
      row.appendChild(pre);
    }

    const transcript = transcriptText(entry.subagent || {});
    if (transcript) {
      const transcriptDetails = document.createElement("details");
      transcriptDetails.className = "assistant-subagent-transcript";
      transcriptDetails.open = false;
      const transcriptSummary = document.createElement("summary");
      transcriptSummary.textContent = translate("subagent.transcript");
      transcriptDetails.appendChild(transcriptSummary);
      const transcriptPre = document.createElement("pre");
      transcriptPre.textContent = transcript;
      transcriptDetails.appendChild(transcriptPre);
      row.appendChild(transcriptDetails);
    }

    list.appendChild(row);
  }
  details.appendChild(list);
  return details;
}
