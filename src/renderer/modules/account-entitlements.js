/**
 * Account credits ("权益概览") on the usage page: token balance, image/video
 * generations and membership expiry as one stat row. Nothing purchased and no
 * membership collapses to a single sentence with the way in — four bold zeros
 * would be a dashboard of nothing.
 */
import { $ } from "./dom.js";
import { t, getLocale } from "../i18n/index.js";

function formatCount(value) {
  return Number(value || 0).toLocaleString(getLocale());
}

/** Membership expiry arrives as an ISO timestamp (e.g. 2027-01-01T00:00:00.000Z);
 *  show a compact date in the UI locale rather than the raw string. */
function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "numeric", day: "numeric" }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function entitlementsEmpty(entitlements) {
  return !Number(entitlements?.tokenBalance)
    && !Number(entitlements?.imageGenerationsRemaining)
    && !Number(entitlements?.videoGenerationsRemaining)
    && !entitlements?.membershipExpiresAt;
}

function emptyLine(onBuy) {
  const line = document.createElement("p");
  line.className = "account-entitlements-empty";
  // Without self-serve purchase (enterprise editions) the way in is the admin.
  line.append(t(typeof onBuy === "function" ? "settings.accountEntitlementsEmpty" : "settings.accountEntitlementsEmptyManaged"), " ");
  if (typeof onBuy === "function") {
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "settings-link-button";
    buy.textContent = t("settings.accountBilling");
    buy.addEventListener("click", () => onBuy());
    line.append(buy);
  }
  return line;
}

function tile(label, value) {
  const card = document.createElement("div");
  card.className = "account-entitlement-card";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.textContent = value;
  card.append(labelEl, valueEl);
  return card;
}

/** `entitlements` null hides the whole section (signed out). */
export function renderEntitlements(entitlements, { onBuy } = {}) {
  const root = $("accountEntitlements");
  const section = $("accountEntitlementsSection");
  if (!root) return;
  if (section) section.hidden = !entitlements;
  if (!entitlements) {
    root.replaceChildren();
    root.classList.remove("is-empty");
    return;
  }
  const empty = entitlementsEmpty(entitlements);
  root.classList.toggle("is-empty", empty);
  if (empty) {
    root.replaceChildren(emptyLine(onBuy));
    return;
  }
  root.replaceChildren(
    tile(t("settings.accountTokens"), formatCount(entitlements.tokenBalance)),
    tile(t("settings.accountImages"), formatCount(entitlements.imageGenerationsRemaining)),
    tile(t("settings.accountVideos"), formatCount(entitlements.videoGenerationsRemaining)),
    tile(t("settings.accountMembership"), entitlements.membershipExpiresAt
      ? formatDate(entitlements.membershipExpiresAt)
      : t("settings.accountInactive")),
  );
}
