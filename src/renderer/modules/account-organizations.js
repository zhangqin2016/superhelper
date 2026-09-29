/**
 * The account page's enterprise-identity card: which identity pays, whether
 * the selected organization is usable, the member's week, and an honest way
 * back to personal. Words come from organization-identity-view.js; the
 * usability rule comes from the main process with each row.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { getLocale, t } from "../i18n/index.js";
import { organizationOptionDisabled, organizationOptionLabel, organizationSelectionNotice, organizationSwitchOutcome, organizationWeeklyText } from "./organization-identity-view.js";

function orgExtraNodes(card) {
  let status = $("accountOrgStatus");
  if (!status) {
    status = document.createElement("p");
    status.id = "accountOrgStatus";
    status.className = "settings-form-status";
    status.setAttribute("role", "status");
    status.hidden = true;
    card.appendChild(status);
  }
  let weekly = $("accountOrgWeekly");
  if (!weekly) {
    weekly = document.createElement("p");
    weekly.id = "accountOrgWeekly";
    weekly.className = "account-org-weekly";
    weekly.hidden = true;
    card.appendChild(weekly);
  }
  let switchBtn = $("accountOrgSwitchPersonalBtn");
  if (!switchBtn) {
    switchBtn = document.createElement("button");
    switchBtn.id = "accountOrgSwitchPersonalBtn";
    switchBtn.type = "button";
    switchBtn.className = "settings-action-btn";
    switchBtn.hidden = true;
    card.appendChild(switchBtn);
  }
  return { status, weekly, switchBtn };
}

function paintOrgStatus(node, text, kind) {
  node.hidden = !text;
  node.textContent = text || "";
  for (const k of ["info", "warning", "error", "success"]) {
    node.classList.toggle(`settings-form-status--${k}`, kind === k);
  }
}

/** Save an identity switch and report what was ACTUALLY saved. */
async function switchOrganization(nextId) {
  let result = null;
  let error = null;
  try {
    result = await window.assistantClient.setCurrentOrganizationId(nextId);
  } catch (err) {
    error = err || new Error("switch failed");
  }
  const outcome = organizationSwitchOutcome(result, nextId, t, error);
  showToast(outcome.text, outcome.kind);
  return outcome;
}

export async function loadOrganizations() {
  const card = $("accountOrgSelectCard");
  const select = $("accountOrgSelect");
  if (!card || !select || !window.assistantClient?.fetchAccountOrganizations) return;
  let result = null;
  try {
    result = await window.assistantClient.fetchAccountOrganizations();
  } catch {
    result = null;
  }
  const rows = Array.isArray(result?.organizations) ? result.organizations : [];
  const current = await window.assistantClient.getCurrentOrganizationId?.().catch(() => ({}));
  const currentId = String(current?.organizationId || "").trim();
  select.innerHTML = "";
  const personal = document.createElement("option");
  personal.value = "";
  personal.textContent = t("settings.accountOrgPersonal");
  select.appendChild(personal);
  for (const row of rows) {
    const opt = document.createElement("option");
    opt.value = String(row.id || "");
    opt.textContent = organizationOptionLabel(row, t);
    // Unusable organizations cannot be picked; the one already selected stays
    // shown as the current value so the user sees what is wrong.
    opt.disabled = organizationOptionDisabled(row);
    select.appendChild(opt);
  }
  if (currentId && !rows.some((row) => String(row.id || "") === currentId)) {
    // The list could not be loaded but a selection exists: show it, so the
    // personal option is a visible change rather than a blank select.
    const opt = document.createElement("option");
    opt.value = currentId;
    opt.textContent = t("orgIdentity.unknownOrg");
    select.appendChild(opt);
  }
  select.value = currentId;
  const { status, weekly, switchBtn } = orgExtraNodes(card);
  const notice = result?.ok ? organizationSelectionNotice(result, rows, t) : { text: "", kind: "", offerSwitch: false };
  paintOrgStatus(status, notice.text, notice.kind);
  const weeklyText = result?.ok && currentId ? organizationWeeklyText(result.currentOrganizationMe, t, getLocale()) : "";
  weekly.hidden = !weeklyText;
  weekly.textContent = weeklyText;
  // Never leave the user without a way back: a flagged selection, or one whose
  // list could not be loaded, gets the one-click switch.
  switchBtn.textContent = t("orgIdentity.switchPersonal");
  switchBtn.hidden = !(currentId && (notice.offerSwitch || !result?.ok));
  switchBtn.onclick = async () => {
    switchBtn.disabled = true;
    try {
      const outcome = await switchOrganization("");
      if (outcome.ok) await loadOrganizations();
    } finally {
      switchBtn.disabled = false;
    }
  };
  card.hidden = rows.length === 0 && !currentId && !notice.text;
  select.onchange = async () => {
    const nextId = select.value || "";
    const outcome = await switchOrganization(nextId);
    if (!outcome.ok) select.value = currentId;
    await loadOrganizations();
  };
}
