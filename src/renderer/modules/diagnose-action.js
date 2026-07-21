/**
 * One-click "diagnose & repair" action for failed assistant turns.
 * Kept out of message.js to respect that module's line ratchet.
 */

import { t } from "../i18n/index.js";

// A failed turn whose retry keeps failing is an environment problem, not a
// message problem — give the user a direct path to the diagnostics page that
// ALSO starts the scan, so "retry → same failure" stops being a dead end.
export function buildDiagnoseAction() {
  const diagnose = document.createElement("button");
  diagnose.type = "button";
  diagnose.className = "assistant-action-btn assistant-diagnose-btn";
  diagnose.textContent = t("turn.diagnoseRepair");
  diagnose.addEventListener("click", async () => {
    diagnose.disabled = true;
    try {
      const { openSettingsPage } = await import("./settings-panel.js");
      openSettingsPage("diagnostics");
      const { runSupportDiagnosticsNow } = await import("./support-diagnostics-settings.js");
      void runSupportDiagnosticsNow();
    } catch (err) {
      void import("./toast.js").then((m) =>
        m.showToast?.(err?.message || t("toast.diagnosticsFailed"), "error"));
    } finally {
      if (diagnose.isConnected) diagnose.disabled = false;
    }
  });
  return diagnose;
}
