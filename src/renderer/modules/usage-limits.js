/**
 * The usage page as Claude and ChatGPT show it: each weekly allowance as
 * "used N%" with a bar and its reset time, the credits beyond it as a balance,
 * and a link to the website statement for charge-by-charge detail. Numbers
 * come from main (usage-limits.js), which reads the server's own counts.
 */
import { $ } from "./dom.js";
import { t, getLocale, onLocaleChange } from "../i18n/index.js";
import { openBilling, purchaseEnabled } from "./account-settings.js";

let current = null;
let generation = 0;
let loading = false;
let failed = false;
let initialized = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function formatCount(value) {
  return new Intl.NumberFormat(getLocale()).format(Number(value) || 0);
}

/** "10月2日周四 10:00" — the reset moment in the viewer's own clock. */
function formatReset(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function limitLabel(limit) {
  if (limit.kind === "plan") return t("usage.limits.plan", { tier: limit.tier === "max" ? "Lily Max" : "Lily Pro" });
  if (limit.kind === "organization") return t("usage.limits.organization");
  return t("usage.limits.license");
}

function limitRow(limit) {
  const row = node("div", "usage-limit");
  const head = node("div", "usage-limit-head");
  const label = limitLabel(limit);
  head.append(node("span", "usage-limit-label", label),
    node("span", "usage-limit-value", limit.unlimited ? t("usage.limits.unlimited") : t("usage.limits.used", { percent: limit.percent })));
  row.append(head);
  if (!limit.unlimited) {
    const bar = node("progress", "usage-limit-bar");
    bar.max = 100;
    bar.value = limit.percent;
    bar.classList.toggle("is-high", limit.percent >= 90);
    bar.setAttribute("aria-label", label + " " + t("usage.limits.used", { percent: limit.percent }));
    row.append(bar);
  }
  const reset = formatReset(limit.resetsAt);
  if (reset && !limit.unlimited) row.append(node("span", "usage-limit-meta", t("usage.limits.resets", { when: reset })));
  return row;
}

function creditsBlock(data) {
  const block = node("div", "usage-credits");
  const head = node("div", "usage-credits-head");
  head.append(node("span", "usage-credits-label", t("usage.limits.extraCredits")),
    node("strong", "usage-credits-value", formatCount(data.extraCredits)));
  if (purchaseEnabled()) {
    const buy = node("button", "settings-action-btn usage-credits-buy", t("usage.limits.topUp"));
    buy.type = "button";
    buy.addEventListener("click", () => void openBilling());
    head.append(buy);
  }
  block.append(head, node("p", "usage-credits-hint", t(data.hasPlan ? "usage.limits.extraAfterPlan" : "usage.limits.extraOnly")));
  for (const [key, value] of [["usage.limits.images", data.images], ["usage.limits.videos", data.videos]]) {
    if (value > 0) block.append(node("p", "usage-credits-line", t(key, { n: formatCount(value) })));
  }
  return block;
}

function render() {
  const list = $("usageLimitsList");
  if (!list) return;
  const data = current;
  // Account parts (balance, top-up, statement) sit in .account-usage-balance,
  // which the edition policy hides where there are no accounts (overseas).
  const accountPart = document.querySelector(".usage-account-part");
  const accounts = Boolean(accountPart) && !accountPart.hidden;
  const account = [];
  if (data?.signedIn && data.identity === "organization") account.push(node("p", "usage-limits-note", t("usage.limits.organizationNote")));
  if (data?.signedIn && data.identity === "personal" && data.extraCredits !== null) account.push(creditsBlock(data));
  if (data && !data.signedIn && !data.limits.length) account.push(node("p", "usage-limits-note", t("usage.limits.signedOut")));
  if (data?.signedIn && !data.limits.length && !account.length) account.push(node("p", "usage-limits-note", t("usage.limits.none")));
  const limits = data ? data.limits.map(limitRow) : [];
  if (data && !limits.length && !accounts) limits.push(node("p", "usage-limits-note", t("usage.limits.none")));
  list.replaceChildren(...limits);
  $("usageCredits")?.replaceChildren(...account);
  const statement = $("usageStatementLink");
  if (statement) statement.hidden = !(data?.signedIn && data.identity === "personal" && purchaseEnabled());
  const status = $("usageLimitsStatus");
  if (status) {
    status.hidden = !loading && !failed;
    status.textContent = loading ? t("usage.limits.loading") : failed ? t("usage.limits.refreshFailed") : "";
  }
  if ($("usageRefresh")) $("usageRefresh").disabled = loading;
}

/** Reads the cached numbers; `refresh: true` asks the server first. */
export async function refreshUsageLimits({ refresh = false } = {}) {
  if (!window.assistantClient?.getUsageLimits) return;
  const request = ++generation;
  loading = refresh;
  failed = false;
  render();
  try {
    const data = await window.assistantClient.getUsageLimits(refresh ? { refresh: true } : undefined);
    if (request !== generation) return;
    if (!data?.ok) throw new Error("USAGE_UNAVAILABLE");
    current = data;
  } catch {
    if (request === generation) failed = true;
  } finally {
    if (request === generation) {
      loading = false;
      render();
    }
  }
}

export function initUsageLimits() {
  if (initialized) return;
  initialized = true;
  $("usageRefresh")?.addEventListener("click", () => void refreshUsageLimits({ refresh: true }));
  $("usageStatementLink")?.addEventListener("click", () => void openBilling({ page: "usage" }));
  window.addEventListener("lily:entitlements-changed", () => void refreshUsageLimits());
  onLocaleChange(render);
}
