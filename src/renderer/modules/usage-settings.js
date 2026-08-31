/**
 * Device-scoped usage. Model identity comes from recorded usage, not the picker.
 */
import { $ } from "./dom.js";
import { t, getLocale, onLocaleChange } from "../i18n/index.js";
import { formatTokenCount } from "./turn-usage-summary.js";
import { showToast } from "./toast.js";

let currentData = null;
let currentView = "dates";
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

function formatCostRmb(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return t("settings.usage.notAvailable");
  if (n > 0 && n < 0.01) return "< ¥0.01";
  return "¥" + n.toFixed(2);
}

function cost(row) {
  return formatCostRmb(row.referenceCostRmb ?? row.costRmb);
}

function tokens(value) {
  return formatTokenCount(value) || "0";
}

function tokenNode(value) {
  const element = node("span", "usage-number", tokens(value));
  element.title = new Intl.NumberFormat(getLocale()).format(value || 0);
  return element;
}

function modelName(row) {
  return row.model === "unknown" ? t("settings.usage.unknownModel") : row.label || row.model;
}

function modelTable(models, label) {
  if (!models.length) return node("p", "usage-empty", t("settings.usage.empty"));
  // A user-send counter records intent, not proof that this model was called.
  models = models.filter(row => row.totalTokens > 0);
  if (!models.length) return node("p", "usage-empty", t("settings.usage.noTokens"));
  const table = node("table", "usage-model-table");
  table.setAttribute("aria-label", label);
  const columns = ["colModels", "colConnection", "colTokens", "colShare", "colCost"];
  const head = node("tr");
  for (const key of columns) {
    const cell = node("th", "", t("settings.usage." + key));
    cell.scope = "col";
    head.append(cell);
  }
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const body = node("tbody");
  for (const row of models) {
    const tr = node("tr", "usage-model-row");
    const cells = columns.map(key => {
      const cell = node("td");
      cell.dataset.label = t("settings.usage." + key);
      return cell;
    });
    const name = node("strong", "usage-model-name", modelName(row));
    name.title = modelName(row);
    cells[0].append(name);
    if (row.model !== "unknown" && row.label && row.label !== row.model) {
      cells[0].append(node("code", "usage-model-id", row.model));
    }
    const connection = ["managed", "custom"].includes(row.connectionType) ? row.connectionType : "unknown";
    cells[1].append(node("span", "", t("settings.usage.connection." + connection)));
    if (row.providerID !== "unknown") cells[1].append(node("code", "usage-connection-id", row.providerID));
    cells[2].append(tokenNode(row.totalTokens), node("span", "usage-in-out", t("settings.usage.inOut", {
      input: tokens(row.inputTokens), output: tokens(row.outputTokens),
    })));
    cells[2].title = new Intl.NumberFormat(getLocale()).format(row.inputTokens) + " / " +
      new Intl.NumberFormat(getLocale()).format(row.outputTokens);
    const share = new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 1 }).format(row.share || 0);
    cells[3].append(node("span", "usage-number", share));
    const bar = node("progress", "usage-share");
    bar.max = 1;
    bar.value = Math.max(0, Math.min(1, row.share || 0));
    bar.setAttribute("aria-label", t("settings.usage.colShare") + " " + modelName(row));
    cells[3].append(bar);
    cells[4].append(node("span", "usage-number", cost(row)));
    tr.append(...cells);
    body.append(tr);
  }
  table.append(body);
  return table;
}

function renderDays(summary, expanded) {
  const body = $("usageHistoryBody");
  if (!body) return;
  body.replaceChildren();
  const rows = [summary.today, ...summary.history].filter(row =>
    row.totalTokens > 0 || row.messageCount > 0 || row.turnCount > 0);
  $("usageDateHeader").hidden = !rows.length;
  if (!rows.length) {
    body.append(node("p", "usage-empty", t("settings.usage.empty")));
    return;
  }
  for (const row of rows) {
    const details = node("details", "usage-day");
    details.dataset.date = row.date;
    details.open = expanded.has(row.date);
    const toggle = node("summary", "usage-day-row");
    const dateLabel = row.date === summary.today.date ? t("settings.usage.today") : row.date;
    const date = node("span", "usage-day-date", dateLabel);
    date.title = row.date;
    const knownModels = row.models.filter(model => model.model !== "unknown" && model.totalTokens > 0);
    const modelCount = new Set(knownModels.map(model => model.model)).size;
    const modelLabel = modelCount === 1
      ? modelName(knownModels[0])
      : t("settings.usage.modelCount", { count: modelCount });
    const names = node("span", "usage-day-models",
      modelCount ? modelLabel : t(row.totalTokens > 0 ? "settings.usage.unknownModel" : "settings.usage.noTokens"));
    names.title = row.models.filter(model => model.totalTokens > 0).map(modelName).join(", ");
    if (modelCount && row.hasUnattributed) names.append(node("small", "", t("settings.usage.partialAttribution")));
    const total = tokenNode(row.totalTokens);
    total.dataset.label = t("settings.usage.colTokens");
    const inOut = node("span", "usage-number usage-day-in-out", tokens(row.inputTokens) + " / " + tokens(row.outputTokens));
    inOut.dataset.label = t("settings.usage.colInOut");
    inOut.title = new Intl.NumberFormat(getLocale()).format(row.inputTokens) + " / " +
      new Intl.NumberFormat(getLocale()).format(row.outputTokens);
    const fee = node("span", "usage-number", cost(row));
    fee.dataset.label = t("settings.usage.colCost");
    toggle.append(date, names, total, inOut, fee);
    details.append(toggle, modelTable(row.models, dateLabel));
    body.append(details);
  }
}

function syncView() {
  if (!$("usageContent")) return;
  $("usageDatesView").hidden = currentView !== "dates";
  $("usageModelsView").hidden = currentView !== "models";
  document.querySelectorAll("[data-usage-view]").forEach(button =>
    button.setAttribute("aria-pressed", String(button.dataset.usageView === currentView)));
}

function renderStatus() {
  const status = $("usageStatus");
  if (status) {
    status.hidden = !loading && !failed;
    status.textContent = loading ? t("settings.usage.loading") : failed
      ? t(currentData ? "settings.usage.refreshFailed" : "settings.usage.loadFailed") : "";
    status.classList.toggle("is-error", failed && !loading);
  }
  if ($("usageRefresh")) $("usageRefresh").disabled = loading;
  $("usageContent")?.setAttribute("aria-busy", String(loading));
}

async function copyDeviceId(deviceId) {
  if (!deviceId) return;
  try {
    await navigator.clipboard.writeText(deviceId);
    showToast(t("settings.usage.deviceIdCopied"), "success");
  } catch {
    showToast(t("common.copyFailed"), "warning");
  }
}

function renderUsageSummary(data) {
  if (!$("usageContent") || !data?.summary) return;
  const summary = data.summary;
  const expanded = new Set([...document.querySelectorAll(".usage-day[open]")].map(day => day.dataset.date));
  const focusedDate = document.activeElement?.closest(".usage-day")?.dataset.date;
  const device = $("usageDeviceId");
  if (device) {
    const value = node("code", "usage-device-value", data.deviceId || t("settings.usage.notAvailable"));
    value.title = data.deviceId || "";
    const copy = node("button", "usage-device-copy", t("common.copy"));
    copy.type = "button";
    copy.disabled = !data.deviceId;
    copy.addEventListener("click", () => copyDeviceId(data.deviceId));
    device.replaceChildren(node("span", "usage-device-label", t("settings.usage.deviceId")), value, copy);
  }
  const source = $("usageDataSource");
  source.hidden = data.source !== "local";
  source.textContent = data.source === "local"
    ? t(data.localReason === "syncing" ? "settings.usage.localSyncing" : "settings.usage.localFallback") : "";

  const grid = node("div", "usage-stat-grid");
  for (const [title, value, meta] of [
    ["tokensToday", tokens(summary.today.totalTokens), t("settings.usage.inOut", {
      input: tokens(summary.today.inputTokens), output: tokens(summary.today.outputTokens),
    })],
    ["costToday", cost(summary.today), t("settings.usage.referenceOnly")],
  ]) {
    const stat = node("div", "usage-stat-card");
    stat.append(node("span", "usage-stat-label", t("settings.usage." + title)),
      node("strong", "usage-stat-value", value), node("span", "usage-stat-meta", meta));
    grid.append(stat);
  }
  $("usageTodayStats").replaceChildren(grid);
  $("usageRangeTotals").textContent = t("settings.usage.rangeSummary", {
    days: summary.historyDays, tokens: tokens(summary.rangeTotals.totalTokens), cost: cost(summary.rangeTotals),
  });
  $("usagePricingNote").textContent = t("settings.usage.pricingNote", {
    input: summary.pricing.inputPerMillion, output: summary.pricing.outputPerMillion,
  });
  renderDays(summary, expanded);
  $("usageModelsView").replaceChildren(modelTable(summary.modelTotals, t("settings.usage.byModel")));
  syncView();
  if (focusedDate) {
    [...document.querySelectorAll(".usage-day")].find(day => day.dataset.date === focusedDate)?.querySelector("summary")?.focus();
  }
}

export async function refreshUsageSettings() {
  if (!window.assistantClient?.getUsageSummary) return;
  const request = ++generation;
  loading = true;
  failed = false;
  renderStatus();
  try {
    const data = await window.assistantClient.getUsageSummary();
    if (request !== generation) return;
    if (!data?.ok || !data.summary) throw new Error("USAGE_UNAVAILABLE");
    renderUsageSummary(data);
    currentData = data;
  } catch {
    if (request === generation) failed = true;
  } finally {
    if (request === generation) {
      loading = false;
      renderStatus();
    }
  }
}

export function initUsageSettings() {
  if (initialized) return;
  initialized = true;
  $("usageRefresh")?.addEventListener("click", refreshUsageSettings);
  document.querySelectorAll("[data-usage-view]").forEach(button => {
    button.addEventListener("click", () => {
      currentView = button.dataset.usageView;
      syncView();
    });
  });
  onLocaleChange(() => {
    if (currentData) renderUsageSummary(currentData);
    renderStatus();
  });
}
