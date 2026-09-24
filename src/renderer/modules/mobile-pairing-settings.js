import { $ } from "./dom.js";
import { getLocale, t } from "../i18n/index.js";
import { showToast } from "./toast.js";

// Desktop "手机控制" settings page — a render of the main process's Mobile
// Command state. The main process owns that state (the control channel feeds
// its phone directory) and PUSHES every change; nothing here polls. Local UI
// state is only what the user has open: the QR panel, the direct-code panel,
// and which unpair is awaiting confirmation.

const PHONE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>';

const ui = {
  state: { channel: "idle", phones: [], pending: [], capabilities: null },
  visible: false,
  challengeExpiresAt: 0,
  direct: null, // { expiresAt, known: Set<grantId> }
  confirmingRevoke: "",
  countdown: null,
  unsubscribe: null,
};

function api() {
  return window.assistantClient || {};
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, variant, onClick) {
  const btn = el("button", `settings-action-btn settings-action-btn--compact${variant ? ` settings-action-btn--${variant}` : ""}`, label);
  btn.type = "button";
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

function phoneIcon() {
  const icon = el("span", "mobile-pair-row-icon");
  icon.innerHTML = PHONE_ICON;
  return icon;
}

function phoneName(grant) {
  // The start of the browser id — what people saw before, so they recognise it.
  const id = String(grant?.mobileDeviceId || "").replace(/^mweb_/, "").slice(0, 6);
  const name = String(grant?.mobileLabel || "").trim() || t("settings.mobilePairUnknownPhone");
  return t("settings.mobilePairDevice", { name, id });
}

function formatDate(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// --- actions ------------------------------------------------------------------

async function run(btn, action, { success } = {}) {
  btn.disabled = true;
  try {
    const res = await action();
    if (!res?.ok) {
      const login = res?.code === "ACCOUNT_LOGIN_REQUIRED";
      showToast(t(login ? "settings.mobilePairLoginRequired" : "settings.mobilePairActionFailed"), login ? "info" : "warning");
      return null;
    }
    if (success) showToast(t(success), "success");
    return res;
  } catch {
    showToast(t("settings.mobilePairActionFailed"), "warning");
    return null;
  } finally {
    btn.disabled = false;
  }
}

async function approve(grantId, btn) {
  // The phone joins the list when the server pushes the activation.
  if (await run(btn, () => api().mobileApprove(grantId), { success: "settings.mobilePairApproved" })) closeChallenge();
}

async function deny(grantId, btn) {
  await run(btn, () => api().mobileDeny(grantId));
}

async function revoke(grantId, btn) {
  if (await run(btn, () => api().mobileRevoke(grantId), { success: "settings.mobilePairRevoked" })) ui.confirmingRevoke = "";
}

async function startPairing(btn) {
  const res = await run(btn, () => api().mobileCreateChallenge());
  if (!res) return;
  closeDirect();
  const code = $("mobilePairCode");
  if (code) code.textContent = `${res.qr?.url || ""}#${res.qr?.token || ""}`;
  const qr = $("mobilePairQr");
  if (qr) {
    if (res.qr?.image) { qr.src = res.qr.image; qr.hidden = false; }
    else { qr.removeAttribute("src"); qr.hidden = true; }
  }
  const panel = $("mobilePairChallenge");
  if (panel) panel.hidden = false;
  const manual = panel?.querySelector(".mobile-pair-manual");
  if (manual) manual.open = !res.qr?.image;
  ui.challengeExpiresAt = Date.parse(String(res.expiresAt || "")) || 0;
  render();
}

async function startDirectCode(btn) {
  const res = await run(btn, () => api().mobileCreateDirectCode());
  if (!res) return;
  closeChallenge();
  const codeEl = $("mobilePairDirectCode");
  const passEl = $("mobilePairDirectPassword");
  if (codeEl) codeEl.textContent = res.code || "";
  if (passEl) passEl.textContent = res.password || "";
  const panel = $("mobilePairDirect");
  if (panel) panel.hidden = false;
  ui.direct = {
    expiresAt: Date.parse(String(res.expiresAt || "")) || 0,
    known: new Set(ui.state.phones.map((p) => p.grantId)),
  };
  render();
}

function closeChallenge() {
  const panel = $("mobilePairChallenge");
  if (panel) panel.hidden = true;
  ui.challengeExpiresAt = 0;
  render();
}

function closeDirect() {
  const panel = $("mobilePairDirect");
  if (panel) panel.hidden = true;
  ui.direct = null;
  render();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text || ""));
    showToast(t("settings.mobilePairCopied"), "success");
  } catch {
    showToast(t("settings.mobilePairActionFailed"), "warning");
  }
}

// --- render -------------------------------------------------------------------

// The channel's own trouble outranks any phone count.
const CHANNEL_NOTICE = {
  "signed-out": ["settings.mobileChannelSignedOut", "warn"],
  "server-outdated": ["settings.mobileChannelOutdated", "warn"],
  offline: ["settings.mobileChannelOffline", "warn"],
  connecting: ["settings.mobileChannelConnecting", ""],
};

function renderSummary() {
  const { phones, channel } = ui.state;
  const title = $("mobilePairSummaryTitle");
  const sub = $("mobilePairBridgeStatus");
  if (title) title.textContent = phones.length ? t("settings.mobileSummaryCount", { count: phones.length }) : t("settings.mobileSummaryNone");
  if (!sub) return;
  sub.replaceChildren();
  const notice = CHANNEL_NOTICE[channel];
  if (notice) {
    sub.append(el("span", `mobile-dot${notice[1] ? ` mobile-dot--${notice[1]}` : ""}`), document.createTextNode(t(notice[0])));
    return;
  }
  if (!phones.length) {
    sub.textContent = t("settings.mobileSummaryHint");
    return;
  }
  const online = phones.filter((p) => p.online).length;
  sub.append(
    el("span", `mobile-dot${online ? " mobile-dot--online" : ""}`),
    document.createTextNode(online ? t("settings.mobileSummaryOnline", { count: online }) : t("settings.mobileSummaryOffline")),
  );
}

function approvalRow(grant, { inline = false } = {}) {
  const row = el("div", inline ? "mobile-pair-inline-row" : "mobile-pair-row");
  const body = el("div", "mobile-pair-row-body");
  body.append(el("div", "mobile-pair-row-name", phoneName(grant)), el("div", "mobile-pair-row-meta", t("settings.mobilePairRequestHint")));
  const actions = el("div", "mobile-pair-row-actions");
  actions.append(
    button(t("settings.mobilePairDeny"), "", (btn) => void deny(grant.grantId, btn)),
    button(t("settings.mobilePairApprove"), "primary", (btn) => void approve(grant.grantId, btn)),
  );
  row.append(phoneIcon(), body, actions);
  return row;
}

function renderPending() {
  const { pending } = ui.state;
  const panelOpen = Boolean(ui.challengeExpiresAt) && !$("mobilePairChallenge")?.hidden;
  // A phone that just scanned appears where the user is looking: the QR panel.
  const [first, ...rest] = pending;
  const inline = $("mobilePairInlinePending");
  if (inline) {
    inline.hidden = !(panelOpen && first);
    inline.replaceChildren(...(panelOpen && first ? [approvalRow(first, { inline: true })] : []));
  }
  const listed = panelOpen ? rest : pending;
  const section = $("mobilePairPendingSection");
  if (section) section.hidden = listed.length === 0;
  $("mobilePairPendingList")?.replaceChildren(...listed.map((g) => approvalRow(g)));
}

function deviceRow(grant) {
  const row = el("div", "mobile-pair-row");
  const body = el("div", "mobile-pair-row-body");
  const meta = el("div", "mobile-pair-row-meta");
  const when = formatDate(grant.approvedAt || grant.createdAt);
  meta.append(
    el("span", `mobile-dot${grant.online ? " mobile-dot--online" : ""}`),
    document.createTextNode([
      grant.online ? t("settings.mobilePairOnline") : t("settings.mobilePairOffline"),
      when ? t("settings.mobilePairPairedAt", { date: when }) : "",
    ].filter(Boolean).join(" · ")),
  );
  body.append(el("div", "mobile-pair-row-name", phoneName(grant)), meta);
  const actions = el("div", "mobile-pair-row-actions");
  if (ui.confirmingRevoke === grant.grantId) {
    actions.append(
      el("span", "mobile-pair-confirm", t("settings.mobilePairRevokeConfirm")),
      button(t("settings.mobilePairCancel"), "", () => { ui.confirmingRevoke = ""; render(); }),
      button(t("settings.mobilePairConfirmRevoke"), "danger", (btn) => void revoke(grant.grantId, btn)),
    );
  } else {
    actions.append(button(t("settings.mobilePairRevoke"), "", () => { ui.confirmingRevoke = grant.grantId; render(); }));
  }
  row.append(phoneIcon(), body, actions);
  return row;
}

function renderDevices() {
  const host = $("mobilePairDeviceList");
  if (!host) return;
  const { phones } = ui.state;
  host.replaceChildren(...(phones.length ? phones.map(deviceRow) : [el("div", "mobile-pair-empty", t("settings.mobilePairNoPaired"))]));
}

function renderCapabilities() {
  const capEl = $("mobilePairCapabilityStatus");
  if (!capEl) return;
  const caps = ui.state.capabilities;
  capEl.hidden = !caps;
  if (!caps) return;
  const liveDisabled = caps.observeControl?.enabled === false && caps.voice?.enabled === false;
  capEl.textContent = t(liveDisabled ? "settings.mobilePairCapabilitiesDemo" : "settings.mobilePairCapabilitiesLive");
}

function renderCountdowns() {
  const now = Date.now();
  const show = (node, expiresAt) => {
    if (!node || !expiresAt) return;
    const left = expiresAt - now;
    node.textContent = left > 0 ? t("settings.mobilePairExpiresIn", { time: formatRemaining(left) }) : t("settings.mobilePairExpired");
    node.classList.toggle("mobile-pair-expiry--expired", left <= 0);
  };
  show($("mobilePairExpiry"), ui.challengeExpiresAt);
  show($("mobilePairDirectExpiry"), ui.direct?.expiresAt);
  const running = ui.visible && Boolean(ui.challengeExpiresAt || ui.direct);
  if (running && !ui.countdown) ui.countdown = setInterval(renderCountdowns, 1000);
  if (!running && ui.countdown) { clearInterval(ui.countdown); ui.countdown = null; }
}

function render() {
  if (!ui.visible) return;
  renderSummary();
  renderPending();
  renderDevices();
  renderCapabilities();
  renderCountdowns();
}

function applyState(next) {
  if (!next?.ok) return;
  ui.state = { channel: next.channel || "idle", phones: next.phones || [], pending: next.pending || [], capabilities: next.capabilities || null };
  if (ui.confirmingRevoke && !ui.state.phones.some((p) => p.grantId === ui.confirmingRevoke)) ui.confirmingRevoke = "";
  // A direct code was used: a phone we did not know is now paired.
  const fresh = ui.direct ? ui.state.phones.find((p) => !ui.direct.known.has(p.grantId)) : null;
  if (fresh) {
    closeDirect();
    showToast(t("settings.mobilePairDirectConnected", { device: phoneName(fresh) }), "success");
    return;
  }
  render();
}

// --- lifecycle ----------------------------------------------------------------

export function initMobilePairingSettings() {
  const startBtn = $("mobilePairStartBtn");
  if (!startBtn || !window.assistantClient?.mobileGetState) {
    // Feature off (kill switch) or unsupported build: hide the nav entry.
    const nav = document.querySelector('.settings-nav-item[data-settings-page="mobile"]');
    if (nav) nav.hidden = true;
    return;
  }
  startBtn.addEventListener("click", () => void startPairing(startBtn));
  const directBtn = $("mobilePairDirectBtn");
  directBtn?.addEventListener("click", () => void startDirectCode(directBtn));
  $("mobilePairChallengeClose")?.addEventListener("click", closeChallenge);
  $("mobilePairDirectClose")?.addEventListener("click", closeDirect);
  $("mobilePairCopyCode")?.addEventListener("click", () => void copyText($("mobilePairCode")?.textContent));
  ui.unsubscribe = api().onMobileState?.(applyState) || null;
}

/** The settings panel opened the mobile page. */
export function onMobilePairingPageShown() {
  if (!window.assistantClient?.mobileGetState) return;
  ui.visible = true;
  render();
  void api().mobileGetState().then(applyState).catch(() => {});
}

export function onMobilePairingPageHidden() {
  ui.visible = false;
  if (ui.countdown) { clearInterval(ui.countdown); ui.countdown = null; }
}
