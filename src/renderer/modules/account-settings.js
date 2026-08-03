import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

let accountLoggedIn = false;
let smsCooldownUntil = 0;
let smsCooldownTimer = null;
let smsSending = false;
let accountLoggingIn = false;
let entitlementsRefreshing = false;
let billingOpening = false;
let accountLoggingOut = false;
let currentAccountPhone = "";

function setStatus(text, kind = "") {
  const el = $("accountFormStatus");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("settings-form-status--error", kind === "error");
  el.classList.toggle("settings-form-status--success", kind === "success");
}

function accountErrorMessage(result, fallbackKey) {
  const code = String(result?.error || result?.json?.code || "").trim();
  if (code) {
    const key = `settings.accountError.${code}`;
    const mapped = t(key);
    if (mapped !== key) return mapped;
  }
  return t(fallbackKey);
}

function updateSmsButton() {
  const btn = $("accountSendSmsBtn");
  if (!btn) return;
  const phone = $("accountPhoneInput")?.value?.trim() || "";
  const remaining = Math.max(0, Math.ceil((smsCooldownUntil - Date.now()) / 1000));
  btn.disabled = accountLoggedIn || smsSending || remaining > 0 || !phone;
  btn.textContent = smsSending
    ? t("settings.accountSending")
    : remaining > 0
    ? t("settings.accountSendSmsCooldown", { seconds: remaining })
    : t("settings.accountSendSms");
}

function updateLoginButton() {
  const btn = $("accountLoginBtn");
  if (!btn) return;
  const phone = $("accountPhoneInput")?.value?.trim() || "";
  const code = $("accountCodeInput")?.value?.trim() || "";
  btn.disabled = accountLoggedIn || accountLoggingIn || !phone || code.length < 4;
  btn.textContent = accountLoggingIn ? t("settings.accountLoggingIn") : t("settings.accountLogin");
}

function updateAccountButtons() {
  updateSmsButton();
  updateLoginButton();
}

function startSmsCooldown(seconds = 60) {
  smsCooldownUntil = Date.now() + Math.max(1, Number(seconds || 60)) * 1000;
  if (smsCooldownTimer) clearInterval(smsCooldownTimer);
  updateSmsButton();
  smsCooldownTimer = setInterval(() => {
    updateSmsButton();
    if (Date.now() >= smsCooldownUntil) {
      clearInterval(smsCooldownTimer);
      smsCooldownTimer = null;
    }
  }, 1000);
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

/** Membership expiry arrives as an ISO timestamp (e.g. 2027-01-01T00:00:00.000Z);
 *  show a readable local date instead of the raw string. */
function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

function renderEntitlements(entitlements) {
  const root = $("accountEntitlements");
  if (!root) return;
  if (!entitlements) {
    root.replaceChildren();
    return;
  }
  const items = [
    [t("settings.accountTokens"), formatCount(entitlements.tokenBalance)],
    [t("settings.accountImages"), formatCount(entitlements.imageGenerationsRemaining)],
    [t("settings.accountVideos"), formatCount(entitlements.videoGenerationsRemaining)],
    [t("settings.accountMembership"), entitlements.membershipExpiresAt ? formatDate(entitlements.membershipExpiresAt) : t("settings.accountInactive")],
  ];
  root.replaceChildren(...items.map(([label, value]) => {
    const card = document.createElement("div");
    card.className = "account-entitlement-card";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const valueEl = document.createElement("strong");
    valueEl.textContent = value;
    card.append(labelEl, valueEl);
    return card;
  }));
}

function setLoggedInUi(loggedIn) {
  accountLoggedIn = Boolean(loggedIn);
  const loginContent = $("accountLoginContent");
  const signedInPanel = $("accountSignedInPanel");
  const actions = document.querySelector(".account-management-actions");
  const title = $("accountAccessTitle");
  const hint = $("accountAccessHint");
  const signedInPhone = $("accountSignedInPhone");
  if (loginContent) loginContent.hidden = accountLoggedIn;
  if (signedInPanel) signedInPanel.hidden = !accountLoggedIn;
  if (actions) actions.hidden = !accountLoggedIn;
  if (title) title.textContent = accountLoggedIn ? t("settings.accountSignedInTitle") : t("settings.accountLoginTitle");
  if (hint) hint.textContent = accountLoggedIn ? t("settings.accountSignedInHint") : t("settings.accountLoginHint");
  if (signedInPhone) signedInPhone.textContent = currentAccountPhone ? t("settings.accountLoggedIn", { phone: currentAccountPhone }) : "";
  updateAccountButtons();
  $("accountRefreshBtn") && ($("accountRefreshBtn").disabled = !loggedIn || entitlementsRefreshing);
  $("accountBillingBtn") && ($("accountBillingBtn").disabled = !loggedIn || billingOpening);
  $("accountLogoutBtn") && ($("accountLogoutBtn").disabled = !loggedIn || accountLoggingOut);
}

export async function refreshAccountSettings() {
  const statusEl = $("accountStatusText");
  if (!statusEl || !window.assistantClient?.getAccountStatus) return;
  let status = null;
  try {
    status = await window.assistantClient.getAccountStatus();
  } catch {
    statusEl.textContent = t("settings.accountStatusFailed");
    setStatus(t("settings.accountStatusFailed"), "error");
    setLoggedInUi(false);
    return;
  }
  if (!status?.loggedIn) {
    currentAccountPhone = "";
    statusEl.textContent = t("settings.accountLoggedOut");
    renderEntitlements(null);
    setLoggedInUi(false);
    const orgCard = $("accountOrgSelectCard");
    if (orgCard) orgCard.hidden = true;
    return;
  }
  currentAccountPhone = status.user?.phoneE164 || status.user?.phone_e164 || "";
  statusEl.textContent = t("settings.accountLoggedIn", {
    phone: currentAccountPhone,
  });
  renderEntitlements(status.entitlements);
  setLoggedInUi(true);
  void loadOrganizations();
}

async function sendSmsCode() {
  if (smsSending || accountLoggedIn || Date.now() < smsCooldownUntil) return;
  const phone = $("accountPhoneInput")?.value || "";
  if (!phone.trim()) {
    setStatus(t("settings.accountPhoneRequired"), "error");
    updateSmsButton();
    return;
  }
  smsSending = true;
  updateSmsButton();
  setStatus(t("settings.accountSending"));
  try {
    const result = await window.assistantClient.sendAccountSmsCode(phone);
    if (!result?.ok) {
      setStatus(accountErrorMessage(result, "settings.accountSendFailed"), "error");
      return;
    }
    if (result.json?.reusedActiveCode) {
      setStatus(t("settings.accountSmsAlreadySent"), "success");
      startSmsCooldown(result.json?.cooldownSeconds || 60);
      return;
    }
    const devCode = result.json?.devCode ? ` ${result.json.devCode}` : "";
    setStatus(`${t("settings.accountSmsSent")}${devCode}`, "success");
    startSmsCooldown(result.json?.cooldownSeconds || 60);
  } finally {
    smsSending = false;
    updateSmsButton();
  }
}

async function loginWithSms(event) {
  event?.preventDefault?.();
  if (accountLoggingIn || accountLoggedIn) return;
  const phone = $("accountPhoneInput")?.value || "";
  const code = $("accountCodeInput")?.value || "";
  if (!phone.trim() || code.trim().length < 4) {
    setStatus(t("settings.accountCodeRequired"), "error");
    updateLoginButton();
    return;
  }
  accountLoggingIn = true;
  updateLoginButton();
  setStatus(t("settings.accountLoggingIn"));
  try {
    const result = await window.assistantClient.loginAccountWithSms({ phone, code });
    if (!result?.ok) {
      setStatus(accountErrorMessage(result, "settings.accountLoginFailed"), "error");
      return;
    }
    setStatus(t("settings.accountLoginDone"), "success");
    await refreshAccountSettings();
    showToast(t("settings.accountLoginDone"), "success");
  } finally {
    accountLoggingIn = false;
    updateLoginButton();
  }
}

async function refreshEntitlements() {
  if (entitlementsRefreshing || !accountLoggedIn) return;
  entitlementsRefreshing = true;
  setLoggedInUi(accountLoggedIn);
  setStatus(t("settings.accountRefreshing"));
  try {
    const result = await window.assistantClient.refreshAccountEntitlements();
    if (!result?.ok) {
      setStatus(accountErrorMessage(result, "settings.accountRefreshFailed"), "error");
      return;
    }
    setStatus(t("settings.accountRefreshed"), "success");
    await refreshAccountSettings();
  } finally {
    entitlementsRefreshing = false;
    setLoggedInUi(accountLoggedIn);
  }
}

async function loadOrganizations() {
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
    opt.textContent = row.name || row.id || "";
    select.appendChild(opt);
  }
  select.value = currentId;
  card.hidden = rows.length === 0;
  if (rows.length > 0) {
    select.onchange = async () => {
      const nextId = select.value || "";
      try {
        await window.assistantClient.setCurrentOrganizationId(nextId);
      } catch {
        // selection persists next time the panel opens
      }
      showToast(
        nextId ? t("settings.accountOrgSet") : t("settings.accountOrgCleared"),
        "success",
      );
    };
  }
}

async function openBilling() {
  if (billingOpening || !accountLoggedIn) return;
  billingOpening = true;
  setLoggedInUi(accountLoggedIn);
  setStatus(t("settings.accountOpeningBilling"));
  try {
    const result = await window.assistantClient.createAccountBillingLink();
    if (!result?.ok || !result.url) {
      setStatus(accountErrorMessage(result, "settings.accountBillingFailed"), "error");
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
    setStatus(t("settings.accountBillingOpened"), "success");
  } finally {
    billingOpening = false;
    setLoggedInUi(accountLoggedIn);
  }
}

async function logout() {
  if (accountLoggingOut) return;
  accountLoggingOut = true;
  setLoggedInUi(accountLoggedIn);
  try {
    await window.assistantClient.logoutAccount();
    setStatus(t("settings.accountLoggedOut"), "success");
    await refreshAccountSettings();
  } finally {
    accountLoggingOut = false;
    setLoggedInUi(accountLoggedIn);
  }
}

export function initAccountSettings() {
  $("accountPhoneInput")?.addEventListener("input", () => updateAccountButtons());
  $("accountCodeInput")?.addEventListener("input", (event) => {
    event.target.value = String(event.target.value || "").replace(/\D/g, "").slice(0, 6);
    updateAccountButtons();
  });
  updateAccountButtons();
  $("accountSendSmsBtn")?.addEventListener("click", () => void sendSmsCode());
  $("accountLoginForm")?.addEventListener("submit", (event) => void loginWithSms(event));
  $("accountRefreshBtn")?.addEventListener("click", () => void refreshEntitlements());
  $("accountBillingBtn")?.addEventListener("click", () => void openBilling());
  $("accountLogoutBtn")?.addEventListener("click", () => void logout());
}
