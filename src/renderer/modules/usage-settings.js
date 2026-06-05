/**
 * Settings — daily token usage from service API with local fallback.
 */

import { $ } from "./dom.js";
import { t } from "../i18n/index.js";
import { formatTokenCount } from "./turn-usage-summary.js";
import { showToast } from "./toast.js";

function formatCostRmb(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "¥0.00";
  if (n < 0.01) return "< ¥0.01";
  return `¥${n.toFixed(2)}`;
}

function formatDateLabel(dateKey) {
  const today = new Date().toISOString().slice(0, 10);
  if (dateKey === today) return t("settings.usage.today");
  return dateKey;
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
  const summary = data?.summary;
  if (!summary) return;

  const deviceEl = $("usageDeviceId");
  if (deviceEl) {
    const deviceId = data.deviceId || "—";
    deviceEl.replaceChildren();

    const label = document.createElement("span");
    label.className = "usage-device-label";
    label.textContent = t("settings.usage.deviceId");

    const value = document.createElement("code");
    value.className = "usage-device-value";
    value.title = deviceId;
    value.textContent = deviceId;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "usage-device-copy";
    copy.textContent = t("common.copy");
    copy.addEventListener("click", () => {
      copyDeviceId(deviceId);
    });

    deviceEl.append(label, value, copy);
  }

  const sourceEl = $("usageDataSource");
  if (sourceEl) {
    if (data.source === "local") {
      sourceEl.textContent = t("settings.usage.localFallback");
      sourceEl.hidden = false;
    } else {
      sourceEl.hidden = true;
      sourceEl.textContent = "";
    }
  }

  const todayEl = $("usageTodayStats");
  if (todayEl && summary.today) {
    const row = summary.today;
    todayEl.innerHTML = `
      <div class="usage-stat-grid">
        <div class="usage-stat-card usage-stat-card--primary">
          <span class="usage-stat-label">${t("settings.usage.tokensToday")}</span>
          <strong class="usage-stat-value">${formatTokenCount(row.totalTokens) || "0"}</strong>
          <span class="usage-stat-meta">${t("settings.usage.inOut", {
            input: formatTokenCount(row.inputTokens) || "0",
            output: formatTokenCount(row.outputTokens) || "0",
          })}</span>
        </div>
        <div class="usage-stat-card">
          <span class="usage-stat-label">${t("settings.usage.costToday")}</span>
          <strong class="usage-stat-value">${formatCostRmb(row.costRmb)}</strong>
        </div>
      </div>
    `;
  }

  const rangeEl = $("usageRangeTotals");
  if (rangeEl && summary.rangeTotals) {
    const totals = summary.rangeTotals;
    rangeEl.textContent = t("settings.usage.rangeSummary", {
      days: summary.historyDays || 30,
      tokens: formatTokenCount(totals.totalTokens) || "0",
      cost: formatCostRmb(totals.costRmb),
    });
  }

  const tbody = $("usageHistoryBody");
  if (!tbody) return;
  const rows = [summary.today, ...(summary.history || [])].filter(Boolean);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="usage-table-empty">${t("settings.usage.empty")}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((row) => {
      const isToday = row.date === summary.today?.date;
      return `<tr class="${isToday ? "is-today" : ""}">
        <td>${formatDateLabel(row.date)}</td>
        <td>${formatTokenCount(row.totalTokens) || "0"}</td>
        <td>${formatTokenCount(row.inputTokens) || "0"} / ${formatTokenCount(row.outputTokens) || "0"}</td>
        <td>${formatCostRmb(row.costRmb)}</td>
      </tr>`;
    })
    .join("");
}

export async function refreshUsageSettings() {
  if (!window.assistantClient?.getUsageSummary) return;
  const data = await window.assistantClient.getUsageSummary();
  if (!data?.ok) return;
  renderUsageSummary(data);
}

export function initUsageSettings() {
  // Reserved for future usage-page listeners.
}
