import { t } from "../i18n/index.js";
import { openSettingsPage, accountFeatureEnabled } from "./settings-panel.js";

// Bottom-left account + quick-actions menu. Shows sign-in state and opens the
// relevant settings page for account / 授权(license) / phone remote-control /
// settings / help. The account row + item are hidden where the account feature
// is gated off (overseas edition), per the account-feature policy. Deep-links via
// openSettingsPage; the 设置 item keeps id="settingsBtn" so its existing binding
// still opens the panel. Fail-open: any error just leaves the default labels.

// Menu action → settings page id. (设置 is handled by settingsBtn's own binding.)
const ACTION_PAGE = { account: "account", license: "license", mobile: "mobile", help: "help" };

const el = (id) => document.getElementById(id);

function maskPhone(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return String(phone || "").trim();
}

function closePopover() {
  const p = el("accountMenuPopover");
  const b = el("accountMenuBtn");
  if (p) p.hidden = true;
  if (b) b.setAttribute("aria-expanded", "false");
}

function openPopover() {
  const p = el("accountMenuPopover");
  const b = el("accountMenuBtn");
  if (!p) return;
  refreshAccountMenu();
  p.hidden = false;
  if (b) b.setAttribute("aria-expanded", "true");
}

// Update the footer row (avatar label + sub) and gate the account item.
export async function refreshAccountMenu() {
  const nameEl = el("accountMenuName");
  const subEl = el("accountMenuSub");
  const acctItem = el("accountMenuItemAccount");
  let enabled = true;
  try { enabled = accountFeatureEnabled(); } catch { enabled = true; }
  if (acctItem) acctItem.hidden = !enabled;

  if (!enabled) {
    // No account concept for this edition — show a neutral quick-menu label.
    if (nameEl) nameEl.textContent = t("account.menu.quickMenu");
    if (subEl) subEl.textContent = t("account.menu.quickHint");
    return;
  }
  if (nameEl) nameEl.textContent = t("account.menu.signedOut");
  if (subEl) subEl.textContent = t("account.menu.signInHint");
  try {
    const status = await window.assistantClient?.getAccountStatus?.();
    if (status?.loggedIn) {
      const phone = status.user?.phoneE164 || status.user?.phone_e164 || "";
      if (nameEl) nameEl.textContent = maskPhone(phone) || t("account.menu.signedIn");
      if (subEl) subEl.textContent = status.entitlements?.membershipExpiresAt
        ? t("account.menu.member")
        : t("account.menu.signedIn");
    }
  } catch {
    /* keep the signed-out default (fail-open) */
  }
}

export function initAccountMenu() {
  const btn = el("accountMenuBtn");
  const popover = el("accountMenuPopover");
  if (!btn || !popover) return;

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (popover.hidden) openPopover(); else closePopover();
  });

  popover.addEventListener("click", (event) => {
    const item = event.target.closest(".account-menu-item");
    if (!item) return;
    closePopover();
    const action = item.dataset.accountAction;
    // 设置 (settingsBtn) has no data-account-action; its own binding opens the panel.
    if (action && ACTION_PAGE[action]) openSettingsPage(ACTION_PAGE[action]);
  });

  // Close on outside click / Escape.
  document.addEventListener("click", (event) => {
    if (popover.hidden) return;
    if (event.target === btn || btn.contains(event.target) || popover.contains(event.target)) return;
    closePopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) closePopover();
  });

  refreshAccountMenu();
}
