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

const PERSON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

function maskPhone(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return String(phone || "").trim();
}

// A deterministic 2-char monogram from the phone tail — gives the signed-in
// avatar identity without exposing the full number.
function phoneMonogram(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  return digits.length >= 2 ? digits.slice(-2) : "";
}

function formatExpiry(value) {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

// Signed-in → accent-filled monogram tile; member adds an accent ring; signed
// out / gated → the neutral outline person. Idempotent across refreshes.
function setAvatar({ signedIn = false, member = false, monogram = "" } = {}) {
  const avatar = el("accountMenuAvatar");
  if (!avatar) return;
  avatar.classList.toggle("is-signed-in", signedIn && !!monogram);
  avatar.classList.toggle("is-member", member);
  avatar.innerHTML = signedIn && monogram
    ? `<span class="account-avatar-monogram">${monogram}</span>`
    : PERSON_SVG;
}

function menuItems() {
  const p = el("accountMenuPopover");
  return p ? [...p.querySelectorAll(".account-menu-item:not([hidden])")] : [];
}

function closePopover({ focusButton = false } = {}) {
  const p = el("accountMenuPopover");
  const b = el("accountMenuBtn");
  if (p) p.hidden = true;
  if (b) {
    b.setAttribute("aria-expanded", "false");
    if (focusButton) b.focus();
  }
}

function openPopover() {
  const p = el("accountMenuPopover");
  const b = el("accountMenuBtn");
  if (!p) return;
  refreshAccountMenu();
  p.hidden = false;
  if (b) b.setAttribute("aria-expanded", "true");
  // Move focus into the menu so it's immediately keyboard-drivable (role=menu).
  menuItems()[0]?.focus();
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
    setAvatar();
    return;
  }
  if (nameEl) nameEl.textContent = t("account.menu.signedOut");
  if (subEl) subEl.textContent = t("account.menu.signInHint");
  setAvatar();
  try {
    const status = await window.assistantClient?.getAccountStatus?.();
    if (status?.loggedIn) {
      const phone = status.user?.phoneE164 || status.user?.phone_e164 || "";
      const expires = status.entitlements?.membershipExpiresAt;
      const member = !!expires;
      if (nameEl) nameEl.textContent = maskPhone(phone) || t("account.menu.signedIn");
      if (subEl) {
        const date = member ? formatExpiry(expires) : "";
        subEl.textContent = member
          ? (date ? `${t("account.menu.member")} · ${date}` : t("account.menu.member"))
          : t("account.menu.signedIn");
      }
      setAvatar({ signedIn: true, member, monogram: phoneMonogram(phone) });
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

  // Arrow-key / Home / End navigation across the visible menu items — fulfils
  // the role="menu" contract. Enter/Space activate natively (they click the
  // focused button, which the item handler above already handles).
  popover.addEventListener("keydown", (event) => {
    const items = menuItems();
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(idx + 1 + items.length) % items.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (event.key === "Tab") {
      closePopover();
    }
  });

  // Close on outside click / Escape (Escape returns focus to the trigger).
  document.addEventListener("click", (event) => {
    if (popover.hidden) return;
    if (event.target === btn || btn.contains(event.target) || popover.contains(event.target)) return;
    closePopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) closePopover({ focusButton: true });
  });

  refreshAccountMenu();
}
