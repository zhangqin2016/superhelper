/**
 * BYOK (自配置模型) plan-gate presentation. The verdict is decided in main
 * (src/main/byok-policy.js) and arrives on IPC payloads as `byok`
 * ({ allowed, reason, pricingUrl }) and per-model `locked`; this module only
 * renders it — it never reads the raw entitlement fields.
 */
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

const DEFAULT_PRICING_URL = "https://lilywb.cn/pricing";

export function byokBlocked(byok) {
  return byok?.allowed === false;
}

export function openPricing(byok) {
  window.open(byok?.pricingUrl || DEFAULT_PRICING_URL, "_blank", "noopener,noreferrer");
}

/** The explanation line + "view plans" button, or null when BYOK is allowed. */
export function byokGateNotice(byok) {
  if (!byokBlocked(byok)) return null;
  const box = document.createElement("div");
  box.className = "settings-form-status settings-form-status--warning byok-gate-notice";
  box.setAttribute("role", "note");
  const text = document.createElement("span");
  text.textContent = t("byok.planRequired");
  const link = document.createElement("button");
  link.type = "button";
  link.className = "settings-link-button";
  link.textContent = t("byok.viewPlans");
  link.addEventListener("click", () => openPricing(byok));
  box.append(text, " ", link);
  return box;
}

/** One-shot: main hands out a notice once per lock episode. */
export function announceByokNotice(notice) {
  const models = Array.isArray(notice?.models) ? notice.models.filter(Boolean) : [];
  if (!models.length) return;
  // showToast renders HTML; model labels are user-typed.
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  showToast(t("byok.switchedNotice", { model: models.map(escape).join(", ") }), "warning", 12000);
}
