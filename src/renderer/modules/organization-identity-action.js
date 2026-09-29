/**
 * One-click "switch to personal identity" on a turn the enterprise identity
 * refused (frozen / paused / removed / weekly allowance or pool used up).
 * Kept out of message.js, like diagnose-action.js.
 *
 * Billing never falls back silently: this button IS the explicit switch, and
 * the toast reports what the main process actually saved.
 */

import { t } from "../i18n/index.js";
import { organizationSwitchOutcome, shouldOfferPersonalSwitch } from "./organization-identity-view.js";

export function buildPersonalIdentityAction(message) {
  if (!shouldOfferPersonalSwitch(message) || !window.assistantClient?.setCurrentOrganizationId) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-action-btn assistant-identity-btn";
  btn.textContent = t("orgIdentity.switchPersonal");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    let result = null;
    let error = null;
    try {
      result = await window.assistantClient.setCurrentOrganizationId("");
    } catch (err) {
      error = err || new Error("switch failed");
    }
    const outcome = organizationSwitchOutcome(result, "", t, error);
    void import("./toast.js").then((m) => m.showToast?.(outcome.text, outcome.kind));
    if (outcome.ok) btn.remove();
    else if (btn.isConnected) btn.disabled = false;
  });
  return btn;
}
