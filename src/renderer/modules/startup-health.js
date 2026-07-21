// Startup health banner. The main process runs a local-only diagnostics pass
// right after launch; if something is already broken (engine missing, corrupt
// session store, duplicate installs, ...) the user gets a persistent banner
// with a one-click path to the diagnostics page — instead of discovering the
// breakage on their first failed send.

import { t } from "../i18n/index.js";
import { openSettingsPage } from "./settings-panel.js";

let banner = null;

function dismiss() {
  if (!banner) return;
  banner.remove();
  banner = null;
}

function render(issues) {
  dismiss();
  banner = document.createElement("div");
  banner.className = "startup-health-banner";
  banner.setAttribute("role", "alert");

  const text = document.createElement("div");
  text.className = "startup-health-text";
  const title = document.createElement("div");
  title.className = "startup-health-title";
  title.textContent = t("startupHealth.title");
  const detail = document.createElement("div");
  detail.className = "startup-health-detail";
  detail.textContent = issues[0]?.message || "";
  text.append(title, detail);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "startup-health-action";
  action.textContent = t("startupHealth.action");
  action.addEventListener("click", () => {
    dismiss();
    openSettingsPage("diagnostics");
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "startup-health-close";
  close.setAttribute("aria-label", t("settings.close"));
  close.textContent = "✕";
  close.addEventListener("click", dismiss);

  banner.append(text, action, close);
  document.body.appendChild(banner);
}

export function initStartupHealth() {
  window.assistantClient.onStartupHealth?.((payload) => {
    if (payload && Array.isArray(payload.issues) && payload.issues.length) {
      render(payload.issues);
    }
  });
}
