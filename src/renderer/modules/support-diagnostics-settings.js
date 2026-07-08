/**
 * Settings — diagnostics, repair, and support upload.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

let lastDiagnostic = null;
let running = false;

function setStatus(key, kind = "info", params = {}) {
  const el = $("supportDiagnosticsStatus");
  if (!el) return;
  if (!key) {
    el.hidden = true;
    el.textContent = "";
    el.className = "settings-form-status";
    return;
  }
  el.hidden = false;
  el.textContent = t(key, params);
  el.className = `settings-form-status settings-form-status--${kind}`;
}

function statusLabel(status) {
  if (status === "ok") return t("settings.diagnosticsStatus.ok");
  if (status === "error") return t("settings.diagnosticsStatus.error");
  return t("settings.diagnosticsStatus.warning");
}

function renderDiagnostic(diagnostic) {
  lastDiagnostic = diagnostic || null;
  const summary = $("supportDiagnosticsSummary");
  const list = $("supportDiagnosticsList");
  if (!summary || !list) return;
  list.replaceChildren();

  if (!diagnostic?.ok) {
    summary.hidden = true;
    return;
  }

  summary.hidden = false;
  summary.className = `settings-diagnostics-summary settings-diagnostics-summary--${diagnostic.summary?.status || "warning"}`;
  summary.textContent = `${diagnostic.summary?.title || t("settings.diagnosticsReady")} · ${t("settings.diagnosticsIssueCount", { count: diagnostic.summary?.issueCount || 0 })}`;

  for (const check of diagnostic.checks || []) {
    const row = document.createElement("div");
    row.className = `settings-diagnostics-row settings-diagnostics-row--${check.status || "warning"}`;

    const badge = document.createElement("span");
    badge.className = "settings-diagnostics-badge";
    badge.textContent = statusLabel(check.status);
    row.appendChild(badge);

    const body = document.createElement("div");
    body.className = "settings-diagnostics-body";
    const title = document.createElement("div");
    title.className = "settings-diagnostics-title";
    title.textContent = check.label || check.id || "";
    body.appendChild(title);
    if (check.detail) {
      const detail = document.createElement("div");
      detail.className = "settings-diagnostics-detail";
      detail.textContent = check.detail;
      body.appendChild(detail);
    }
    row.appendChild(body);
    list.appendChild(row);
  }
}

async function runDiagnostics() {
  if (running) return;
  running = true;
  const runBtn = $("supportDiagnosticsRunBtn");
  if (runBtn) runBtn.disabled = true;
  setStatus("settings.diagnosticsRunning", "info");
  try {
    const result = await window.assistantClient.runSupportDiagnostics();
    if (!result?.ok) {
      setStatus("settings.diagnosticsFailed", "error");
      showToast(t("toast.diagnosticsFailed"), "error");
      return;
    }
    renderDiagnostic(result);
    setStatus("settings.diagnosticsReady", result.summary?.status === "ok" ? "success" : "warning");
  } finally {
    running = false;
    if (runBtn) runBtn.disabled = false;
  }
}

async function restoreDefaultModel() {
  const btn = $("supportDiagnosticsRestoreBtn");
  if (btn) btn.disabled = true;
  setStatus("settings.diagnosticsRestoring", "info");
  try {
    const result = await window.assistantClient.diagnoseAndRestoreDefaultModel();
    if (!result?.ok) {
      setStatus("settings.diagnosticsRestoreFailed", "error");
      showToast(t("toast.modelSwitchFailed"), "error");
      return;
    }
    showToast(t("toast.modelDiagnoseRestoreDone"), "success");
    await runDiagnostics();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function sendDiagnostics() {
  const btn = $("supportDiagnosticsSendBtn");
  if (btn) btn.disabled = true;
  setStatus("settings.diagnosticsUploading", "info");
  try {
    const diagnostic = lastDiagnostic || await window.assistantClient.runSupportDiagnostics();
    const result = await window.assistantClient.submitDiagnosticsFeedback({
      message: $("supportDiagnosticsMessage")?.value?.trim() || "",
      diagnostic,
    });
    if (!result?.ok) {
      setStatus("settings.diagnosticsUploadFailed", "error");
      showToast(t("toast.diagnosticsUploadFailed"), "error");
      return;
    }
    setStatus("settings.diagnosticsUploaded", "success");
    showToast(t("toast.diagnosticsUploaded"), "success");
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function initSupportDiagnosticsSettings() {
  $("supportDiagnosticsRunBtn")?.addEventListener("click", () => void runDiagnostics());
  $("supportDiagnosticsRestoreBtn")?.addEventListener("click", () => void restoreDefaultModel());
  $("supportDiagnosticsSendBtn")?.addEventListener("click", () => void sendDiagnostics());
}
