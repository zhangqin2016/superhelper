/**
 * License activation and static update checks in About settings.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

let latestPackageUrl = "";
let autoUpdateListenersStarted = false;
let lastRendererCheckAt = 0;
let updateState = null;

const AUTO_UPDATE_FOCUS_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;
const AUTO_UPDATE_REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const AUTO_UPDATE_REMIND_KEY = "lily:last-update-reminder";

function licenseErrorMessage(error) {
  const key = `license.error.${error || "GENERIC"}`;
  const text = t(key);
  return text === key ? t("license.error.GENERIC") : text;
}

function modelConfigErrorMessage(error) {
  const key = `modelConfig.error.${error || "GENERIC"}`;
  const text = t(key);
  return text === key ? t("modelConfig.error.GENERIC") : text;
}

function updateErrorMessage(error) {
  const code = typeof error === "string" ? error : error?.code;
  const key = `update.error.${code || "GENERIC"}`;
  const text = t(key);
  if (text !== key) return text;
  if (typeof error === "object" && error?.detail) return error.detail;
  return t("update.error.GENERIC");
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

export async function refreshLicenseStatus() {
  const el = $("licenseStatusText");
  if (!el) return;
  const status = await window.assistantClient.getLicenseStatus();
  if (!status?.activated) {
    el.textContent = t("settings.licenseInactive");
    return;
  }
  if (status.valid) {
    el.textContent = t("settings.licenseValid", {
      customer: status.license?.customer || status.license?.licenseId || "",
      expiresAt: formatDate(status.license?.expiresAt),
      plan: status.license?.plan || "",
    });
  } else {
    el.textContent = t("settings.licenseInvalid", {
      error: licenseErrorMessage(status.error),
    });
  }
}

export async function refreshUpdateSettings() {
  await window.assistantClient.getUpdateSettings?.();
  const state = await window.assistantClient.getUpdateState?.();
  if (state?.ok !== undefined) renderUpdateState(state);
}

async function checkUpdates() {
  latestPackageUrl = "";
  const downloadBtn = $("updateDownloadBtn");
  if (downloadBtn) downloadBtn.hidden = true;
  const statusEl = $("updateStatusText");
  if (statusEl) statusEl.textContent = t("settings.updateChecking");

  const result = await window.assistantClient.checkForUpdates();
  if (!result?.ok) {
    if (statusEl) statusEl.textContent = updateErrorMessage(result?.error);
    showToast(updateErrorMessage(result?.error), "error");
    return;
  }
  renderUpdateState(result);

  if (!result.hasUpdate) {
    if (statusEl) {
      statusEl.textContent = t("settings.updateLatest", {
        version: result.currentVersion,
      });
    }
    showToast(t("toast.updateAlreadyLatest"), "success");
    return;
  }

  latestPackageUrl = result.package?.url || "";
  if (statusEl) {
    statusEl.textContent = t("settings.updateAvailable", {
      current: result.currentVersion,
      latest: result.latestVersion,
    });
  }
  if (downloadBtn) downloadBtn.hidden = !latestPackageUrl;
  showToast(t("toast.updateAvailable"), "info");
}

function readLastUpdateReminder() {
  try {
    return JSON.parse(localStorage.getItem(AUTO_UPDATE_REMIND_KEY) || "{}");
  } catch {
    return {};
  }
}

function shouldRemindUpdate(latestVersion) {
  const last = readLastUpdateReminder();
  if (last.version !== latestVersion) return true;
  const ts = Number(last.ts || 0);
  return !ts || Date.now() - ts > AUTO_UPDATE_REMIND_COOLDOWN_MS;
}

function markUpdateReminder(latestVersion) {
  try {
    localStorage.setItem(AUTO_UPDATE_REMIND_KEY, JSON.stringify({
      version: latestVersion,
      ts: Date.now(),
    }));
  } catch {
    // non-critical reminder persistence
  }
}

function applyUpdateAvailable(result) {
  renderUpdateState(result);
  latestPackageUrl = result.package?.url || "";
  const statusEl = $("updateStatusText");
  if (statusEl) {
    statusEl.textContent = t("settings.updateAvailable", {
      current: result.currentVersion,
      latest: result.latestVersion,
    });
  }
  const downloadBtn = $("updateDownloadBtn");
  if (downloadBtn) downloadBtn.hidden = !latestPackageUrl;
}

function maybeShowUpdateReminder(result) {
  if (!result?.hasUpdate) return;
  if (!shouldRemindUpdate(result.latestVersion)) return;
  markUpdateReminder(result.latestVersion);

  const toast = showToast(
    t("toast.updateAvailableVersion", { version: result.latestVersion }),
    "info",
    12000,
  );
  const packageUrl = result.package?.url || latestPackageUrl;
  if (!packageUrl) return;
  toast.style.cursor = "pointer";
  toast.addEventListener("click", async () => {
    const opened = result.canAutoInstall
      ? await window.assistantClient.downloadUpdate()
      : await window.assistantClient.openUpdateDownload(packageUrl);
    if (!opened?.ok) showToast(updateErrorMessage(opened?.error), "error");
  }, { once: true });
}

function handleUpdateStatePush(state) {
  renderUpdateState(state);
  if (!state?.hasUpdate || state.phase !== "available") return;
  applyUpdateAvailable(state);
  maybeShowUpdateReminder(state);
}

async function kickUpdateCheckIfDue(minGapMs = AUTO_UPDATE_FOCUS_MIN_INTERVAL_MS) {
  const now = Date.now();
  if (now - lastRendererCheckAt < minGapMs) return;
  lastRendererCheckAt = now;
  await window.assistantClient.kickUpdateCheck?.();
}

function phaseText(state) {
  if (!state?.hasUpdate && state?.phase !== "error") return "";
  if (state.phase === "checking") return t("update.pillChecking");
  if (state.phase === "downloading") {
    const percent = Math.max(0, Math.min(100, Number(state.progress?.percent || 0)));
    return t("update.pillDownloading", { percent: Math.round(percent) });
  }
  if (state.phase === "downloaded") return t("update.pillDownloaded");
  if (state.phase === "restart_pending") return t("update.pillRestartPending");
  if (state.phase === "error") return t("update.pillError");
  return t("update.pillAvailable");
}

function updateDescription(state) {
  if (state.phase === "checking") return t("update.descChecking");
  if (state.phase === "downloading") return t("update.descDownloading");
  if (state.phase === "downloaded") {
    return t("update.descDownloaded", { version: state.latestVersion || "" });
  }
  if (state.phase === "restart_pending") return t("update.descRestartPending");
  if (state.phase === "error") return updateErrorMessage(state.error);
  if (state.canAutoInstall) {
    return t("update.descAvailableAuto", {
      current: state.currentVersion || "",
      latest: state.latestVersion || "",
    });
  }
  return t("update.descAvailableManual", {
    current: state.currentVersion || "",
    latest: state.latestVersion || "",
  });
}

function primaryButtonText(state) {
  if (state.phase === "downloaded" || state.phase === "restart_pending") return t("update.restart");
  if (state.phase === "downloading" || state.phase === "checking" || state.phase === "installing") {
    return t("update.working");
  }
  if (state.canAutoInstall) return t("update.downloadAndInstall");
  return t("settings.updateDownload");
}

function renderUpdateState(state) {
  updateState = state || updateState;
  if (!updateState) return;
  latestPackageUrl = updateState.package?.url || "";

  const chrome = $("updateChrome");
  const pillText = $("updatePillText");
  const title = $("updatePopoverTitle");
  const desc = $("updatePopoverDesc");
  const progressTrack = $("updateProgressTrack");
  const progressBar = $("updateProgressBar");
  const primary = $("updatePrimaryBtn");
  const statusEl = $("updateStatusText");
  const downloadBtn = $("updateDownloadBtn");

  const visible = updateState.hasUpdate || ["checking", "downloading", "downloaded", "restart_pending", "error"].includes(updateState.phase);
  if (chrome) {
    chrome.hidden = !visible;
    chrome.dataset.phase = updateState.phase || "idle";
  }
  if (pillText) pillText.textContent = phaseText(updateState);
  if (title) title.textContent = updateState.phase === "error" ? t("update.popoverErrorTitle") : t("update.popoverTitle");
  if (desc) desc.textContent = updateDescription(updateState);

  const percent = Math.max(0, Math.min(100, Number(updateState.progress?.percent || 0)));
  if (progressTrack) progressTrack.hidden = updateState.phase !== "downloading";
  if (progressBar) progressBar.style.width = `${percent}%`;

  const primaryDisabled = ["checking", "downloading", "installing"].includes(updateState.phase);
  if (primary) {
    primary.textContent = primaryButtonText(updateState);
    primary.disabled = primaryDisabled;
  }

  if (statusEl) {
    if (updateState.phase === "error") {
      statusEl.textContent = updateErrorMessage(updateState.error);
    } else if (!updateState.hasUpdate) {
      statusEl.textContent = t("settings.updateLatest", { version: updateState.currentVersion || "" });
    } else {
      statusEl.textContent = t("settings.updateAvailable", {
        current: updateState.currentVersion || "",
        latest: updateState.latestVersion || "",
      });
    }
  }
  if (downloadBtn) {
    downloadBtn.hidden = !(updateState.hasUpdate && (updateState.canAutoInstall || updateState.canManualDownload || latestPackageUrl));
    downloadBtn.textContent = primaryButtonText(updateState);
    downloadBtn.disabled = primaryDisabled;
  }
}

async function runPrimaryUpdateAction() {
  const state = updateState || await window.assistantClient.getUpdateState?.();
  if (!state) return;
  let result;
  if (state.phase === "downloaded" || state.phase === "restart_pending") {
    result = await window.assistantClient.installUpdate({ force: false });
  } else if (state.canAutoInstall) {
    result = await window.assistantClient.downloadUpdate();
  } else if (state.package?.url) {
    result = await window.assistantClient.openUpdateDownload(state.package.url);
  } else {
    result = await window.assistantClient.checkForUpdates();
  }
  if (!result?.ok) showToast(updateErrorMessage(result?.error), "error");
  else if (result.phase || result.hasUpdate !== undefined) renderUpdateState(result);
}

export function startAutoUpdateChecks() {
  if (autoUpdateListenersStarted) return;
  autoUpdateListenersStarted = true;

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    void kickUpdateCheckIfDue();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
}

export function kickAutoUpdateCheck() {
  lastRendererCheckAt = 0;
  void kickUpdateCheckIfDue(0);
}

export function initLicenseUpdateSettings() {
  window.assistantClient.onUpdateState?.((state) => {
    handleUpdateStatePush(state);
  });
  $("updatePillBtn")?.addEventListener("click", () => {
    const popover = $("updatePopover");
    if (popover) popover.hidden = !popover.hidden;
  });
  $("updatePopoverCloseBtn")?.addEventListener("click", () => {
    const popover = $("updatePopover");
    if (popover) popover.hidden = true;
  });
  $("updateSecondaryBtn")?.addEventListener("click", () => {
    const popover = $("updatePopover");
    if (popover) popover.hidden = true;
  });
  $("updatePrimaryBtn")?.addEventListener("click", () => void runPrimaryUpdateAction());

  $("licenseActivateBtn")?.addEventListener("click", async () => {
    const token = $("licenseTokenInput")?.value?.trim() || "";
    if (!token) {
      showToast(t("license.error.INVALID_FORMAT"), "error");
      return;
    }
    const result = await window.assistantClient.activateLicense(token);
    if (!result?.ok) {
      showToast(licenseErrorMessage(result?.error), "error");
      await refreshLicenseStatus();
      return;
    }
    $("licenseTokenInput").value = "";
    await refreshLicenseStatus();
    showToast(
      result.modelConfigReady === false
        ? t("toast.licenseActivatedModelConfigPending", {
            error: modelConfigErrorMessage(result.modelConfigError),
          })
        : t("toast.licenseActivated"),
      result.modelConfigReady === false ? "warning" : "success",
    );
    kickAutoUpdateCheck();
  });

  $("licenseClearBtn")?.addEventListener("click", async () => {
    await window.assistantClient.clearLicense();
    await refreshLicenseStatus();
    showToast(t("toast.licenseCleared"), "info");
  });

  $("updateCheckBtn")?.addEventListener("click", () => void checkUpdates());
  $("updateDownloadBtn")?.addEventListener("click", () => void runPrimaryUpdateAction());
}
