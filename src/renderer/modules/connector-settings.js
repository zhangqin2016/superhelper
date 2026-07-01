/**
 * Connector and account settings.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

function value(id) {
  return $(id)?.value?.trim() || "";
}

function checked(id) {
  return Boolean($(id)?.checked);
}

function setVal(id, v) {
  const el = $(id);
  if (el) el.value = v == null ? "" : String(v);
}

function setChecked(id, v) {
  const el = $(id);
  if (el) el.checked = Boolean(v);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
let activeConnectorTab = "mail";
let connectorTabsInitialized = false;

function setConnectorTab(tab) {
  activeConnectorTab = tab === "web" ? "web" : "mail";
  document.querySelectorAll("[data-connector-tab]").forEach((button) => {
    const isActive = button.dataset.connectorTab === activeConnectorTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll("[data-connector-panel]").forEach((panel) => {
    const isActive = panel.dataset.connectorPanel === activeConnectorTab;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });
}

function initConnectorTabs() {
  if (connectorTabsInitialized) {
    setConnectorTab(activeConnectorTab);
    return;
  }
  connectorTabsInitialized = true;
  document.querySelectorAll("[data-connector-tab]").forEach((button) => {
    button.addEventListener("click", () => setConnectorTab(button.dataset.connectorTab));
  });
  setConnectorTab(activeConnectorTab);
}

// Foolproof add-flow: the moment a valid email is entered, fill IMAP/SMTP from
// autodiscovery and surface app-password guidance, so the user only enters the
// password/授权码 and never touches a host or port.
async function autodiscoverEmail() {
  const provider = value("connectorProviderSelect") || "imap-smtp";
  if (provider !== "imap-smtp") return;
  const email = value("connectorAccountEmail");
  if (!EMAIL_RE.test(email)) return;
  let res;
  try {
    res = await window.assistantClient.autodiscoverMailAccount(email);
  } catch {
    return;
  }
  const config = res?.ok ? res.config : null;
  if (!config) return;

  setVal("connectorImapHost", config.imap.host);
  setVal("connectorImapPort", config.imap.port);
  setChecked("connectorImapSecure", config.imap.secure);
  setVal("connectorSmtpHost", config.smtp.host);
  setVal("connectorSmtpPort", config.smtp.port);
  setChecked("connectorSmtpSecure", config.smtp.secure);

  // Server fields stay collapsed (auto-filled); the user only enters the secret.
  const fields = $("connectorImapFields");
  if (fields) fields.hidden = true;
  renderAutoGuidance(config);

  const secretLabel = document.querySelector('label[for="connectorAccountSecret"]');
  if (secretLabel) {
    secretLabel.textContent = config.secretKind === "app-password" ? t("connectors.secretAppPassword") : t("connectors.secretMailPassword");
  }
}

function manualToggleButton() {
  const manual = document.createElement("button");
  manual.type = "button";
  manual.className = "settings-link-button";
  manual.textContent = t("connectors.manualServer");
  manual.addEventListener("click", () => {
    const fields = $("connectorImapFields");
    if (fields) fields.hidden = !fields.hidden;
  });
  return manual;
}

function ensureGuidanceBox() {
  const anchor = $("connectorAccountEmail");
  if (!anchor) return null;
  let box = $("connectorAutoGuidance");
  if (!box) {
    box = document.createElement("div");
    box.id = "connectorAutoGuidance";
    box.className = "settings-section-desc";
    anchor.insertAdjacentElement("afterend", box);
  }
  return box;
}

function hideAutoGuidance() {
  const box = $("connectorAutoGuidance");
  if (box) box.hidden = true;
}

// config === null → initial hint (before an email is entered).
function renderAutoGuidance(config) {
  const box = ensureGuidanceBox();
  if (!box) return;
  box.replaceChildren();

  if (!config) {
    const hint = document.createElement("p");
    hint.textContent = t("connectors.autoHint");
    box.append(hint, manualToggleButton());
    box.hidden = false;
    return;
  }

  const summary = document.createElement("p");
  summary.textContent = t("connectors.autoSummary", { imap: config.imap.host, smtp: config.smtp.host });
  box.appendChild(summary);

  if (config.secretKind === "app-password" || config.guidance) {
    const tip = document.createElement("p");
    tip.textContent = config.guidance?.text || t("connectors.appPasswordTip");
    if (config.guidance?.url) {
      const link = document.createElement("a");
      link.href = config.guidance.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = " " + t("connectors.viewGuide");
      tip.appendChild(link);
    }
    box.appendChild(tip);
  }

  box.appendChild(manualToggleButton());
  box.hidden = false;
}

function setStatus(text, kind = "") {
  const el = $("connectorSettingsStatus");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.className = `settings-form-status${kind ? ` settings-form-status--${kind}` : ""}`;
}

function providerLabel(provider) {
  if (provider === "imap-smtp") return t("settings.connectors.provider.imap");
  if (provider === "gmail") return t("settings.connectors.provider.gmail");
  if (provider === "outlook") return t("settings.connectors.provider.outlook");
  if (provider === "microsoft-365") return t("settings.connectors.provider.microsoft365");
  return provider || "";
}

function renderAccount(account) {
  const row = document.createElement("div");
  row.className = "connector-account-row";

  const meta = document.createElement("div");
  meta.className = "connector-account-meta";

  const name = document.createElement("div");
  name.className = "connector-account-name";
  name.textContent = account.label || account.account;

  const details = document.createElement("div");
  details.className = "connector-account-details";
  const status = account.status === "connected"
    ? t("settings.connectors.status.connected")
    : account.status === "configured"
      ? t("settings.connectors.status.configured")
      : t("settings.connectors.status.needsConfig");
  details.textContent = `${providerLabel(account.provider)} · ${account.account} · ${status}`;

  meta.append(name, details);

  const actions = document.createElement("div");
  actions.className = "connector-account-actions";

  if (account.authType === "oauth2") {
    const authorize = document.createElement("button");
    authorize.type = "button";
    authorize.className = "settings-action-btn settings-action-btn--primary";
    authorize.textContent = account.status === "connected"
      ? t("settings.connectors.reauthorize")
      : t("settings.connectors.authorize");
    authorize.addEventListener("click", async () => {
      authorize.disabled = true;
      setStatus(t("settings.connectors.authorizing"));
      const result = await window.assistantClient.authorizeMailAccount(account.id);
      authorize.disabled = false;
      if (result?.ok) {
        setStatus(t("settings.connectors.authorizeOk"), "success");
        showToast(t("settings.connectors.authorizeOk"), "success");
        await refreshConnectorSettings();
      } else {
        setStatus(result?.message || t("settings.connectors.authorizeFailed"), "error");
        showToast(t("settings.connectors.authorizeFailed"), "error");
      }
    });
    actions.appendChild(authorize);
  }

  const test = document.createElement("button");
  test.type = "button";
  test.className = "settings-action-btn";
  test.textContent = t("settings.connectors.test");
  test.addEventListener("click", async () => {
    test.disabled = true;
    setStatus(t("settings.connectors.testing"));
    const result = await window.assistantClient.testMailAccount(account.id);
    test.disabled = false;
    if (result?.ok) {
      setStatus(t("settings.connectors.testOk"), "success");
      showToast(t("settings.connectors.testOk"), "success");
    } else {
      setStatus(result?.message || t("settings.connectors.testFailed"), "error");
      showToast(t("settings.connectors.testFailed"), "error");
    }
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "settings-action-btn settings-action-btn--danger";
  remove.textContent = t("settings.connectors.remove");
  remove.addEventListener("click", async () => {
    const result = await window.assistantClient.removeMailAccount(account.id);
    if (!result?.ok) {
      showToast(t("settings.connectors.removeFailed"), "error");
      return;
    }
    showToast(t("settings.connectors.removed"), "success");
    await refreshConnectorSettings();
  });

  actions.append(test, remove);
  row.append(meta, actions);
  return row;
}

export async function refreshConnectorSettings() {
  const list = $("connectorAccountsList");
  if (!list) return;
  const data = await window.assistantClient.listMailAccounts();
  list.replaceChildren();
  const accounts = data?.accounts || [];
  if (!accounts.length) {
    const empty = document.createElement("p");
    empty.className = "connector-account-empty";
    empty.textContent = t("settings.connectors.empty");
    list.appendChild(empty);
    return;
  }
  for (const account of accounts) list.appendChild(renderAccount(account));
}

function updateProviderFields() {
  const provider = value("connectorProviderSelect") || "imap-smtp";
  const isImap = provider === "imap-smtp";
  // Foolproof default for IMAP: the server block stays collapsed (auto-filled
  // from the email); the user sees only email + secret. The guidance box offers
  // a "manual" reveal. OAuth shows its own fields.
  if ($("connectorImapFields")) $("connectorImapFields").hidden = true;
  if ($("connectorSecretField")) $("connectorSecretField").hidden = !isImap;
  if ($("connectorOauthFields")) $("connectorOauthFields").hidden = isImap;
  if (isImap) renderAutoGuidance(null);
  else hideAutoGuidance();
}

function buildPayload() {
  const provider = value("connectorProviderSelect") || "imap-smtp";
  const payload = {
    provider,
    label: value("connectorAccountLabel"),
    account: value("connectorAccountEmail"),
  };
  if (provider === "imap-smtp") {
    payload.secret = value("connectorAccountSecret");
    payload.imap = {
      host: value("connectorImapHost"),
      port: Number(value("connectorImapPort") || 993),
      secure: checked("connectorImapSecure"),
    };
    payload.smtp = {
      host: value("connectorSmtpHost"),
      port: Number(value("connectorSmtpPort") || 465),
      secure: checked("connectorSmtpSecure"),
    };
  } else {
    payload.oauth = {
      clientId: value("connectorOauthClientId"),
      tenantId: value("connectorOauthTenantId"),
    };
  }
  return payload;
}

function setWebCredStatus(text, kind = "") {
  const el = $("webCredStatus");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  el.className = `settings-form-status${kind ? ` settings-form-status--${kind}` : ""}`;
}

function renderWebCredential(cred) {
  const row = document.createElement("div");
  row.className = "connector-account-row";
  const meta = document.createElement("div");
  meta.className = "connector-account-meta";
  const name = document.createElement("div");
  name.className = "connector-account-name";
  name.textContent = cred.domain;
  const details = document.createElement("div");
  details.className = "connector-account-details";
  const status = cred.secretSet ? t("settings.connectors.webCredSecretSet") : t("settings.connectors.webCredNoSecret");
  details.textContent = cred.username ? `${cred.username} · ${status}` : status;
  meta.append(name, details);

  const actions = document.createElement("div");
  actions.className = "connector-account-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "settings-action-btn settings-action-btn--danger";
  remove.textContent = t("settings.connectors.remove");
  remove.addEventListener("click", async () => {
    const result = await window.assistantClient.removeWebCredential(cred.domain);
    if (!result?.ok) {
      showToast(t("settings.connectors.removeFailed"), "error");
      return;
    }
    showToast(t("settings.connectors.removed"), "success");
    await refreshWebCredentials();
  });
  actions.appendChild(remove);
  row.append(meta, actions);
  return row;
}

export async function refreshWebCredentials() {
  const list = $("webCredentialsList");
  if (!list) return;
  const data = await window.assistantClient.listWebCredentials();
  list.replaceChildren();
  const creds = data?.credentials || [];
  if (!creds.length) {
    const empty = document.createElement("p");
    empty.className = "connector-account-empty";
    empty.textContent = t("settings.connectors.webCredEmpty");
    list.appendChild(empty);
    return;
  }
  for (const cred of creds) list.appendChild(renderWebCredential(cred));
}

export async function initConnectorSettings() {
  initConnectorTabs();
  updateProviderFields();
  await refreshConnectorSettings();

  $("connectorProviderSelect")?.addEventListener("change", updateProviderFields);
  $("connectorAccountEmail")?.addEventListener("change", () => void autodiscoverEmail());
  $("connectorAccountEmail")?.addEventListener("blur", () => void autodiscoverEmail());
  $("connectorSaveAccountBtn")?.addEventListener("click", async () => {
    setStatus("");
    const button = $("connectorSaveAccountBtn");
    if (button) button.disabled = true;
    const result = await window.assistantClient.saveMailAccount(buildPayload());
    if (button) button.disabled = false;
    if (!result?.ok) {
      setStatus(result?.message || t("settings.connectors.saveFailed"), "error");
      showToast(t("settings.connectors.saveFailed"), "error");
      return;
    }
    setStatus(t("settings.connectors.saved"), "success");
    showToast(t("settings.connectors.saved"), "success");
    await refreshConnectorSettings();
  });

  await refreshWebCredentials();
  $("webCredSaveBtn")?.addEventListener("click", async () => {
    setWebCredStatus("");
    const button = $("webCredSaveBtn");
    if (button) button.disabled = true;
    const result = await window.assistantClient.saveWebCredential({
      domain: value("webCredDomain"),
      loginUrl: value("webCredLoginUrl"),
      username: value("webCredUsername"),
      password: value("webCredPassword"),
    });
    if (button) button.disabled = false;
    if (!result?.ok) {
      setWebCredStatus(result?.message || t("settings.connectors.webCredSaveFailed"), "error");
      showToast(t("settings.connectors.webCredSaveFailed"), "error");
      return;
    }
    setWebCredStatus(t("settings.connectors.webCredSaved"), "success");
    showToast(t("settings.connectors.webCredSaved"), "success");
    setVal("webCredPassword", ""); // never keep the typed password in the field
    await refreshWebCredentials();
  });
}
