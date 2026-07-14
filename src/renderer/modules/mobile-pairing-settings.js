import { $ } from "./dom.js";
import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";

// Desktop "Mobile Command" settings panel: generate a pairing code (rendered as
// a code the mobile web page consumes), poll for pending requests a mobile has
// raised, and approve/deny them. On approval the main process brings the relay
// bridge online. Pure renderer over the preload mobilePairing* IPC surface.
//
// NOTE (device-validation pending): the visual/UX of this panel and the phone
// flow need validation against a running app + server + phone. The wiring and
// IPC contract are exercised by unit/e2e tests; the pixels are not.

let pollTimer = null;

function api() {
  return window.assistantClient || {};
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function renderPendingList(grants = []) {
  const host = $("mobilePairPendingList");
  if (!host) return;
  host.replaceChildren();
  if (!grants.length) {
    const empty = document.createElement("p");
    empty.className = "settings-section-desc";
    empty.textContent = t("settings.mobilePairNoPending");
    host.appendChild(empty);
    return;
  }
  for (const g of grants) {
    const row = document.createElement("div");
    row.className = "settings-memory-item";
    const label = document.createElement("span");
    label.className = "mobile-pair-pending-device";
    label.textContent = t("settings.mobilePairDevice", { id: String(g.mobileDeviceId || "").slice(0, 12) });
    const actions = document.createElement("div");
    actions.className = "settings-memory-item-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "settings-action-btn settings-action-btn--primary settings-action-btn--compact";
    approve.textContent = t("settings.mobilePairApprove");
    approve.addEventListener("click", () => void decide("approve", g.grantId, approve));
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "settings-action-btn settings-action-btn--compact";
    deny.textContent = t("settings.mobilePairDeny");
    deny.addEventListener("click", () => void decide("deny", g.grantId, deny));
    actions.append(approve, deny);
    row.append(label, actions);
    host.appendChild(row);
  }
}

async function decide(kind, grantId, btn) {
  if (!grantId) return;
  btn.disabled = true;
  try {
    const res = kind === "approve"
      ? await api().mobilePairingApprove?.(grantId)
      : await api().mobilePairingDeny?.(grantId);
    if (!res?.ok) {
      showToast(t("settings.mobilePairActionFailed"), "warning");
      return;
    }
    if (kind === "approve") {
      showToast(t("settings.mobilePairApproved"), "success");
      await refreshBridgeStatus();
      await refreshDevices();
    }
    await refreshPending();
  } catch {
    showToast(t("settings.mobilePairActionFailed"), "warning");
  } finally {
    btn.disabled = false;
  }
}

async function refreshPending() {
  const res = await api().mobilePairingPollPending?.();
  if (res?.ok) renderPendingList(res.grants || []);
}

function renderDeviceList(grants = []) {
  const host = $("mobilePairDeviceList");
  if (!host) return;
  host.replaceChildren();
  const active = grants.filter((g) => g.status === "active");
  if (!active.length) {
    const empty = document.createElement("p");
    empty.className = "settings-section-desc";
    empty.textContent = t("settings.mobilePairNoPaired");
    host.appendChild(empty);
    return;
  }
  for (const g of active) {
    const row = document.createElement("div");
    row.className = "settings-memory-item";
    const label = document.createElement("span");
    label.className = "mobile-pair-pending-device";
    label.textContent = t("settings.mobilePairDevice", { id: String(g.mobileDeviceId || "").slice(0, 12) });
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "settings-action-btn settings-action-btn--danger settings-action-btn--compact";
    revoke.textContent = t("settings.mobilePairRevoke");
    revoke.addEventListener("click", () => void doRevoke(g.grantId, revoke));
    const actions = document.createElement("div");
    actions.className = "settings-memory-item-actions";
    actions.append(revoke);
    row.append(label, actions);
    host.appendChild(row);
  }
}

async function doRevoke(grantId, btn) {
  if (!grantId) return;
  btn.disabled = true;
  try {
    const res = await api().mobilePairingRevoke?.({ grantId, reason: "user_action" });
    if (!res?.ok) { showToast(t("settings.mobilePairActionFailed"), "warning"); return; }
    showToast(t("settings.mobilePairRevoked"), "success");
    await refreshDevices();
    await refreshBridgeStatus();
  } catch {
    showToast(t("settings.mobilePairActionFailed"), "warning");
  } finally {
    btn.disabled = false;
  }
}

async function refreshDevices() {
  const res = await api().mobilePairingListDevices?.();
  if (res?.ok) renderDeviceList(res.grants || []);
}

async function refreshBridgeStatus() {
  const el = $("mobilePairBridgeStatus");
  const capEl = $("mobilePairCapabilityStatus");
  if (!el && !capEl) return;
  const res = await api().mobilePairingStatus?.();
  const bridged = Boolean(res?.bridged);
  if (el) {
    el.hidden = !bridged;
    if (bridged) el.textContent = t("settings.mobilePairBridged");
  }
  if (capEl) {
    const caps = res?.capabilities || {};
    const liveDisabled = caps.observeControl?.enabled === false && caps.voice?.enabled === false;
    capEl.hidden = !res?.ok;
    capEl.textContent = liveDisabled
      ? t("settings.mobilePairCapabilitiesDemo")
      : t("settings.mobilePairCapabilitiesLive");
  }
}

async function startPairing(btn) {
  btn.disabled = true;
  try {
    const res = await api().mobilePairingCreateChallenge?.();
    if (!res?.ok) {
      const key = res?.code === "ACCOUNT_LOGIN_REQUIRED" ? "settings.mobilePairLoginRequired" : "settings.mobilePairChallengeFailed";
      showToast(t(key), res?.code === "ACCOUNT_LOGIN_REQUIRED" ? "info" : "warning");
      return;
    }
    const wrap = $("mobilePairChallenge");
    const code = $("mobilePairCode");
    if (code) {
      // The mobile page consumes this compact payload (server url + token).
      code.textContent = `${res.qr?.url || ""}#${res.qr?.token || ""}`;
    }
    const qrImg = $("mobilePairQr");
    if (qrImg) {
      // Scannable QR when the main process could render it; otherwise stay
      // hidden and let the text code below carry the manual-paste path.
      if (res.qr?.image) { qrImg.src = res.qr.image; qrImg.hidden = false; }
      else { qrImg.removeAttribute("src"); qrImg.hidden = true; }
    }
    if (wrap) wrap.hidden = false;
    const expiry = $("mobilePairExpiry");
    if (expiry && res.expiresAt) {
      expiry.textContent = t("settings.mobilePairExpiry", { time: new Date(res.expiresAt).toLocaleTimeString() });
    }
    await refreshPending();
  } catch {
    showToast(t("settings.mobilePairChallengeFailed"), "warning");
  } finally {
    btn.disabled = false;
  }
}

export function initMobilePairingSettings() {
  const startBtn = $("mobilePairStartBtn");
  if (!startBtn || !window.assistantClient?.mobilePairingCreateChallenge) {
    // Feature off (kill switch) or unsupported build: hide the nav entry.
    const nav = document.querySelector('.settings-nav-item[data-settings-page="mobile"]');
    if (nav) nav.hidden = true;
    return;
  }
  startBtn.addEventListener("click", () => void startPairing(startBtn));
}

/** Called when the settings panel opens the mobile page — start polling. */
export function onMobilePairingPageShown() {
  if (!window.assistantClient?.mobilePairingPollPending) return;
  void refreshPending();
  void refreshDevices();
  void refreshBridgeStatus();
  stopPolling();
  pollTimer = setInterval(() => { void refreshPending(); }, 3000);
}

export function onMobilePairingPageHidden() {
  stopPolling();
}
